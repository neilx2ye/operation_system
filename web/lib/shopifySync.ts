// Shopify 全量同步:用 Bulk Operations 拉取商品/订单,分页拉取弃购,
// 转换成 mock.ts 使用的数据结构,写入 data/shopify-cache.json(mock.ts 检测到该文件后自动切换为真实数据)。
// 需要 Admin API scopes: read_products, read_inventory, read_orders, read_all_orders, read_customers

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { shopifyConfig, type ShopifyConfig } from '@/lib/shopifyFulfill';

const DATA_DIR = path.join(process.cwd(), 'data');
const CACHE_FILE = path.join(DATA_DIR, 'shopify-cache.json');
const STATUS_FILE = path.join(DATA_DIR, 'shopify-sync-status.json');
const MAX_ABANDON_PAGES = 40;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r2 = (n: number) => Math.round(n * 100) / 100;
const toNum = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const gidNum = (gid?: string | null) => (gid ? String(gid).split('/').pop()!.split('?')[0] : '');
const sha = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);

// ---------- 状态 ----------

export type SyncStatus = {
  state: 'idle' | 'running' | 'done' | 'error';
  step: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  counts: Record<string, number> | null;
  warnings: string[];
};

const IDLE: SyncStatus = { state: 'idle', step: '', startedAt: null, finishedAt: null, error: null, counts: null, warnings: [] };

function writeStatus(s: SyncStatus) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATUS_FILE, JSON.stringify(s));
}

export function readStatus(): SyncStatus {
  let s: SyncStatus = IDLE;
  try {
    s = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch {}
  if (s.state === 'running' && !(globalThis as any).__opsSyncRunning) {
    return { ...s, state: 'error', error: '同步进程已中断(服务重启?),请重新触发' };
  }
  return s;
}

// ---------- Shopify GraphQL ----------

async function gql(cfg: ShopifyConfig, query: string, variables: Record<string, unknown> = {}): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://${cfg.shop}/admin/api/${cfg.version}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': cfg.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30000),
    });
    const json: any = await res.json().catch(() => null);
    const throttled = res.status === 429 || JSON.stringify(json?.errors ?? '').includes('THROTTLED');
    if (throttled && attempt < 8) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (!res.ok || !json) throw new Error('Shopify HTTP ' + res.status);
    if (json.errors?.length) throw new Error('Shopify GraphQL: ' + JSON.stringify(json.errors).slice(0, 600));
    return json.data;
  }
}

async function runBulk(cfg: ShopifyConfig, inner: string, label: string, setStep: (s: string) => void): Promise<any[]> {
  const deadline = Date.now() + 40 * 60_000;
  for (;;) {
    const d = await gql(cfg, `{ currentBulkOperation(type: QUERY) { id status } }`);
    const st = d.currentBulkOperation?.status;
    if (st !== 'CREATED' && st !== 'RUNNING') break;
    if (Date.now() > deadline) throw new Error('等待已有 Bulk 任务超时');
    setStep(label + ': 等待店铺上一个 Bulk 任务结束…');
    await sleep(5000);
  }
  const s = await gql(
    cfg,
    `mutation($q: String!) { bulkOperationRunQuery(query: $q) { bulkOperation { id status } userErrors { field message } } }`,
    { q: inner },
  );
  const errs = s.bulkOperationRunQuery.userErrors;
  if (errs?.length) throw new Error('Bulk 启动失败: ' + JSON.stringify(errs));
  const id = s.bulkOperationRunQuery.bulkOperation.id as string;
  for (;;) {
    await sleep(3000);
    const p = await gql(cfg, `query($id: ID!) { node(id: $id) { ... on BulkOperation { status errorCode objectCount url } } }`, { id });
    const n = p.node;
    setStep(`${label}: ${n?.status} · 已处理 ${n?.objectCount ?? 0} 条`);
    if (n?.status === 'COMPLETED') {
      if (!n.url) return [];
      const r = await fetch(n.url);
      if (!r.ok) throw new Error('下载 Bulk 结果失败 HTTP ' + r.status);
      const text = await r.text();
      const out: any[] = [];
      for (const line of text.split('\n')) if (line.trim()) out.push(JSON.parse(line));
      return out;
    }
    if (n?.status === 'FAILED' || n?.status === 'CANCELED' || n?.status === 'EXPIRED') {
      throw new Error(`Bulk ${label} ${n.status} ${n.errorCode ?? ''}`.trim());
    }
    if (Date.now() > deadline) throw new Error('Bulk ' + label + ' 超时');
  }
}

const PRODUCT_Q = `{ productVariants { edges { node {
  id sku title displayName price inventoryQuantity
  selectedOptions { name value }
  product { id title productType status }
  inventoryItem { unitCost { amount } measurement { weight { value unit } } }
} } } }`;

const VISIT = `source sourceType referrerUrl landingPage utmParameters { source medium }`;

const ORDER_Q = `{ orders { edges { node {
  id name createdAt cancelledAt test email phone
  customer { id email firstName lastName defaultAddress { countryCodeV2 } }
  shippingAddress { name phone address1 address2 city provinceCode zip countryCodeV2 }
  refunds { createdAt }
  customerJourneySummary { firstVisit { ${VISIT} } lastVisit { ${VISIT} } }
  lineItems { edges { node {
    id quantity refundableQuantity sku title
    variant { id }
    discountedUnitPriceSet { shopMoney { amount } }
  } } }
} } } }`;

const ABANDON_Q = `query($after: String) { abandonedCheckouts(first: 25, after: $after) {
  pageInfo { hasNextPage endCursor }
  nodes {
    id createdAt completedAt
    totalPriceSet { shopMoney { amount } }
    customer { id email defaultAddress { countryCodeV2 } }
    lineItems(first: 10) { nodes { quantity variant { id } } }
  }
} }`;

// ---------- 转换 ----------

const GRAMS: Record<string, number> = { GRAMS: 1, KILOGRAMS: 1000, OUNCES: 28.3495, POUNDS: 453.592 };
const STATUS_MAP: Record<string, string> = { ACTIVE: 'active', DRAFT: 'draft', ARCHIVED: 'archived' };

function buildProducts(rows: any[]) {
  const seen = new Set<string>();
  const list: any[] = [];
  for (const v of rows) {
    if (v.__parentId || !v.id) continue;
    const vid = gidNum(v.id);
    const spu: string = v.product?.title || v.displayName || 'Unknown';
    const variant: string = !v.title || v.title === 'Default Title' ? '' : v.title;
    let sku = String(v.sku || '').trim() || 'V' + vid;
    if (seen.has(sku)) sku = sku + '-' + vid;
    seen.add(sku);
    const w = v.inventoryItem?.measurement?.weight;
    list.push({
      id: 'v' + vid,
      title: variant ? spu + ' - ' + variant : spu,
      spu,
      variant,
      sku,
      weightG: w ? Math.round(toNum(w.value) * (GRAMS[w.unit] ?? 1)) : 0,
      stock: Math.max(0, Math.round(toNum(v.inventoryQuantity))),
      reorderPoint: 30,
      leadTimeDays: 14,
      supplier: '',
      status: STATUS_MAP[v.product?.status] || 'active',
      category: v.product?.productType || 'Uncategorized',
      price: r2(toNum(v.price)),
      cost: r2(toNum(v.inventoryItem?.unitCost?.amount)),
      refundProb: 0,
      pop: 0,
    });
  }
  return list;
}

// 渠道归类(用 Shopify 自带的 customerJourneySummary,优先末次访问)
function channelOf(o: any): string {
  const j = o.customerJourneySummary;
  const v = j?.lastVisit || j?.firstVisit;
  if (!v) return 'direct';
  const utm = v.utmParameters || {};
  const src = String(utm.source || v.source || '').toLowerCase();
  const medium = String(utm.medium || '').toLowerCase();
  const landing = String(v.landingPage || '').toLowerCase();
  const paid = /cpc|ppc|paid|ads|display|shopping|cpm/.test(medium) || /[?&](gclid|gbraid|wbraid)=/.test(landing);
  if (/tiktok/.test(src) || landing.includes('ttclid=')) return 'tiktok';
  if (/facebook|^fb$|instagram|^ig$|meta/.test(src) || landing.includes('fbclid=')) return 'meta';
  if (/google/.test(src) || /[?&](gclid|gbraid|wbraid)=/.test(landing)) return paid ? 'google' : 'organic';
  if (/klaviyo|email|newsletter|mailchimp/.test(src) || medium === 'email') return 'email';
  if (/bing|yahoo|duckduckgo|baidu|ecosia|yandex/.test(src)) return 'organic';
  if (!src || v.sourceType === 'DIRECT') return 'direct';
  return src.slice(0, 30);
}

function buildOrders(rows: any[], products: any[]) {
  const orderRows = new Map<string, any>();
  const lineRows = new Map<string, any[]>();
  for (const r of rows) {
    if (r.__parentId) {
      const arr = lineRows.get(r.__parentId);
      if (arr) arr.push(r);
      else lineRows.set(r.__parentId, [r]);
    } else orderRows.set(r.id, r);
  }

  const prodById = new Map<string, any>(products.map((p) => [p.id, p]));
  const ensureProduct = (li: any): string => {
    const key = li.variant?.id ? 'v' + gidNum(li.variant.id) : 'x' + sha(String(li.sku || li.title || li.id));
    if (!prodById.has(key)) {
      const price = r2(toNum(li.discountedUnitPriceSet?.shopMoney?.amount));
      const title = String(li.title || '已删除商品');
      const p = {
        id: key, title, spu: title, variant: '', sku: String(li.sku || '').trim() || key.toUpperCase(),
        weightG: 0, stock: 0, reorderPoint: 30, leadTimeDays: 14, supplier: '', status: 'archived',
        category: 'Deleted/Custom', price, cost: 0, refundProb: 0, pop: 0,
      };
      prodById.set(key, p);
      products.push(p);
    }
    return key;
  };

  const sorted = [...orderRows.values()].filter((o) => !o.test && !o.cancelledAt).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const customers = new Map<string, any>();
  const orders: any[] = [];

  for (const o of sorted) {
    const t = Date.parse(o.createdAt);
    const email = String(o.customer?.email || o.email || '').toLowerCase();
    const cid = o.customer?.id ? 'c' + gidNum(o.customer.id) : email ? 'g' + sha(email) : 'g' + gidNum(o.id);
    const a = o.shippingAddress;
    const country = a?.countryCodeV2 || o.customer?.defaultAddress?.countryCodeV2 || 'N/A';
    const fullName = [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(' ');
    if (!customers.has(cid)) {
      customers.set(cid, { id: cid, email: email || '(无邮箱)', country, source: channelOf(o), name: a?.name || fullName || '', phone: a?.phone || o.phone || '' });
    }

    const refunds: any[] = o.refunds || [];
    const refundAt = refunds.length ? Math.max(...refunds.map((r) => Date.parse(r.createdAt))) : t;
    const items: any[] = [];
    for (const li of lineRows.get(o.id) || []) {
      const qty = Math.round(toNum(li.quantity));
      if (qty <= 0) continue;
      const productId = ensureProduct(li);
      const price = r2(toNum(li.discountedUnitPriceSet?.shopMoney?.amount));
      const refQty = Math.max(0, Math.min(qty, qty - Math.round(toNum(li.refundableQuantity ?? qty))));
      if (refQty < qty) items.push({ productId, qty: qty - refQty, price, refunded: false, refundAt: null });
      if (refQty > 0) items.push({ productId, qty: refQty, price, refunded: true, refundAt });
    }
    if (!items.length) continue;

    orders.push({
      id: String(o.name),
      customerId: cid,
      t,
      items,
      shipping: a
        ? { name: a.name || fullName || '', phone: a.phone || o.phone || '', line1: a.address1 || '', line2: a.address2 || '', city: a.city || '', state: a.provinceCode || '', zip: a.zip || '', country: a.countryCodeV2 || country }
        : undefined,
    });
  }
  return { orders, customers };
}

async function fetchAbandons(cfg: ShopifyConfig, customers: Map<string, any>, setStep: (s: string) => void, warnings: string[]) {
  const abandons: any[] = [];
  let after: string | null = null;
  let page = 0;
  for (;;) {
    const d: any = await gql(cfg, ABANDON_Q, { after });
    const conn = d.abandonedCheckouts;
    for (const c of conn.nodes) {
      if (c.completedAt || !c.customer?.email) continue;
      const cid = 'c' + gidNum(c.customer.id);
      if (!customers.has(cid)) {
        customers.set(cid, { id: cid, email: String(c.customer.email).toLowerCase(), country: c.customer.defaultAddress?.countryCodeV2 || 'N/A', source: 'direct', name: '', phone: '' });
      }
      const items = (c.lineItems?.nodes || [])
        .filter((x: any) => x.variant?.id)
        .map((x: any) => ({ productId: 'v' + gidNum(x.variant.id), qty: Math.round(toNum(x.quantity)) || 1 }));
      if (!items.length) continue;
      abandons.push({ customerId: cid, t: Date.parse(c.createdAt), value: r2(toNum(c.totalPriceSet?.shopMoney?.amount)), items });
    }
    page++;
    setStep(`弃购: 已拉取 ${page} 页 · ${abandons.length} 条`);
    if (!conn.pageInfo.hasNextPage) break;
    if (page >= MAX_ABANDON_PAGES) {
      warnings.push(`弃购仅同步了最近 ${page * 25} 条检出记录(上限 ${MAX_ABANDON_PAGES} 页)`);
      break;
    }
    after = conn.pageInfo.endCursor;
  }
  return abandons;
}

// ---------- 入口 ----------

async function run(cfg: ShopifyConfig) {
  const st: SyncStatus = { ...IDLE, state: 'running', startedAt: new Date().toISOString(), warnings: [] };
  const step = (s: string) => {
    st.step = s;
    writeStatus(st);
  };
  try {
    step('拉取商品…');
    const products = buildProducts(await runBulk(cfg, PRODUCT_Q, '商品', step));
    const variantCount = products.length;

    step('拉取订单(全量,可能需要几分钟)…');
    const { orders, customers } = buildOrders(await runBulk(cfg, ORDER_Q, '订单', step), products);

    let abandons: any[] = [];
    try {
      abandons = await fetchAbandons(cfg, customers, step, st.warnings);
    } catch (e: any) {
      st.warnings.push('弃购同步失败(已跳过): ' + (e?.message || String(e)).slice(0, 200));
    }
    const known = new Set(products.map((p) => p.id));
    abandons = abandons
      .map((a) => ({ ...a, items: a.items.filter((it: any) => known.has(it.productId)) }))
      .filter((a) => a.items.length);

    step('写入缓存…');
    const payload = {
      syncedAt: new Date().toISOString(),
      shop: cfg.shop,
      products,
      customers: [...customers.values()],
      orders,
      abandons,
    };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, CACHE_FILE);

    st.state = 'done';
    st.step = '完成';
    st.counts = { variants: variantCount, products: products.length, customers: customers.size, orders: orders.length, abandons: abandons.length };
  } catch (e: any) {
    st.state = 'error';
    st.error = e?.message || String(e);
  } finally {
    st.finishedAt = new Date().toISOString();
    writeStatus(st);
    (globalThis as any).__opsSyncRunning = false;
  }
}

export function startSync(): { started: boolean; message: string } {
  const g = globalThis as any;
  if (g.__opsSyncRunning) return { started: false, message: '同步正在进行中' };
  const cfg = shopifyConfig();
  if (!cfg) return { started: false, message: '未配置 Shopify 店铺域名 / Admin Token' };
  g.__opsSyncRunning = true;
  void run(cfg);
  return { started: true, message: '已开始同步' };
}
