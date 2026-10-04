// Shopify 全量同步:用 Bulk Operations 拉取商品/订单,分页拉取弃购,
// 转换成 mock.ts 使用的数据结构,写入数据库 shopify_cache 表(mock.ts 检测到缓存后自动切换为真实数据)。
// 需要 Admin API scopes: read_products, read_inventory, read_orders, read_all_orders, read_customers

import crypto from 'node:crypto';
import { shopifyConfig, type ShopifyConfig } from '@/lib/shopifyFulfill';
import { readShopifyCache, readSyncStatusDoc, writeShopifyCache, writeSyncStatusDoc } from '@/lib/db/docs';
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
  /** full=全量同步；incremental=只拉取自上次以来的变更 */
  mode?: 'full' | 'incremental';
  step: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  counts: Record<string, number> | null;
  warnings: string[];
};

const IDLE: SyncStatus = { state: 'idle', mode: 'full', step: '', startedAt: null, finishedAt: null, error: null, counts: null, warnings: [] };

/** 增量游标回退的安全余量：避免 bulk 期间写入的变更被漏掉（重复拉取是幂等的） */
const CURSOR_SAFETY_MS = 5 * 60_000;

// 状态写入串行化，保证多次 step 的落库顺序与调用顺序一致
let statusWriteQueue: Promise<unknown> = Promise.resolve();
function writeStatus(s: SyncStatus): void {
  const snap = structuredClone(s);
  statusWriteQueue = statusWriteQueue.then(() => writeSyncStatusDoc(snap)).catch(() => undefined);
}

export async function readStatus(): Promise<SyncStatus> {
  const stored = (await readSyncStatusDoc()) as SyncStatus | null;
  const s: SyncStatus = stored && typeof stored === 'object' ? { ...IDLE, ...stored } : IDLE;
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

const PRODUCT_NODE = `id sku title displayName price inventoryQuantity
  selectedOptions { name value }
  product { id title productType status featuredMedia { preview { image { url } } } }
  inventoryItem { unitCost { amount } measurement { weight { value unit } } }`;

const PRODUCT_Q = `{ productVariants { edges { node { ${PRODUCT_NODE} } } } }`;

/** 只取 updated_at 晚于 since 的商品变体（since 为不带毫秒的 ISO，如 2026-10-03T12:00:00Z） */
const productQSince = (since: string) => `{ productVariants(query: "updated_at:>'${since}'") { edges { node { ${PRODUCT_NODE} } } } }`;

const VISIT = `source sourceType referrerUrl landingPage utmParameters { source medium }`;

const ORDER_NODE = `id name createdAt cancelledAt test email phone displayFulfillmentStatus
  customer { id email firstName lastName tags defaultAddress { countryCodeV2 } }
  shippingAddress { name phone address1 address2 city provinceCode zip countryCodeV2 }
  refunds { createdAt }
  fulfillments(first: 10) { displayStatus updatedAt }
  customerJourneySummary { firstVisit { ${VISIT} } lastVisit { ${VISIT} } }
  lineItems { edges { node {
    id quantity refundableQuantity sku title name
    image { url }
    variant { id }
    discountedUnitPriceSet { shopMoney { amount } }
  } } }`;

const ORDER_Q = `{ orders { edges { node { ${ORDER_NODE} } } } }`;

/** 只取 updated_at 晚于 since 的订单 */
const orderQSince = (since: string) => `{ orders(query: "updated_at:>'${since}'") { edges { node { ${ORDER_NODE} } } } }`;

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
const FULFILLMENT_DISPLAY_LABELS: Record<string, string> = {
  ATTEMPTED_DELIVERY: '已尝试派送',
  CANCELED: '物流已取消',
  CARRIER_PICKED_UP: '承运商已揽收',
  CONFIRMED: '已确认发货',
  DELAYED: '物流延误',
  DELIVERED: '已送达',
  FAILURE: '物流异常',
  FULFILLED: '已发货',
  IN_TRANSIT: '运输中',
  LABEL_PRINTED: '面单已打印',
  LABEL_PURCHASED: '面单已购买',
  LABEL_VOIDED: '面单已作废',
  MARKED_AS_FULFILLED: '已标记发货',
  NOT_DELIVERED: '未送达',
  OUT_FOR_DELIVERY: '派送中',
  PICKED_UP: '已取件',
  READY_FOR_PICKUP: '待取件',
  SUBMITTED: '已提交承运商',
};
const ORDER_FULFILLMENT_LABELS: Record<string, string> = {
  FULFILLED: '已发货',
  IN_PROGRESS: '发货处理中',
  ON_HOLD: '暂停发货',
  OPEN: '未发货',
  PARTIALLY_FULFILLED: '部分发货',
  PENDING_FULFILLMENT: '等待履约',
  REQUEST_DECLINED: '履约被拒',
  RESTOCKED: '未发货',
  SCHEDULED: '已排期发货',
  UNFULFILLED: '未发货',
};

function logisticsStatusOf(o: any): string {
  const fulfillments = Array.isArray(o.fulfillments) ? o.fulfillments : [];
  const latest = fulfillments
    .filter((f: any) => f?.displayStatus)
    .slice()
    .sort((a: any, b: any) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''))[0];
  if (latest?.displayStatus) return FULFILLMENT_DISPLAY_LABELS[latest.displayStatus] || String(latest.displayStatus);
  return ORDER_FULFILLMENT_LABELS[o.displayFulfillmentStatus] || '未发货';
}

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
      imageUrl: String(v.product?.featuredMedia?.preview?.image?.url || ''),
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
      const title = String(li.name || li.title || '已删除商品');
      const p = {
        id: key, title, spu: title, variant: '', sku: String(li.sku || '').trim() || key.toUpperCase(), imageUrl: String(li.image?.url || ''),
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
      customers.set(cid, {
        id: cid,
        email: email || '(无邮箱)',
        country,
        source: channelOf(o),
        name: a?.name || fullName || '',
        phone: a?.phone || o.phone || '',
        tags: Array.isArray(o.customer?.tags) ? o.customer.tags.map(String) : [],
      });
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
      const itemMeta = { title: String(li.name || li.title || prodById.get(productId)?.title || '已删除商品'), imageUrl: String(li.image?.url || prodById.get(productId)?.imageUrl || '') };
      if (refQty < qty) items.push({ productId, qty: qty - refQty, price, refunded: false, refundAt: null, ...itemMeta });
      if (refQty > 0) items.push({ productId, qty: refQty, price, refunded: true, refundAt, ...itemMeta });
    }
    if (!items.length) continue;

    orders.push({
      id: String(o.name),
      customerId: cid,
      t,
      items,
      logisticsStatus: logisticsStatusOf(o),
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

/** 读取当前缓存（增量同步的基线）。 */
async function readCachePayload(): Promise<any | null> {
  const doc = await readShopifyCache();
  const raw = doc.data as any;
  if (!raw || !Array.isArray(raw.products) || !Array.isArray(raw.orders) || !Array.isArray(raw.customers)) return null;
  return raw;
}

/** 按 id 合并：新数据覆盖同 id 的旧记录，未出现的旧记录保持不变。 */
function upsertById<T>(current: T[], incoming: T[], keyOf: (t: T) => string, merge?: (old: T, inc: T) => T): T[] {
  const map = new Map<string, T>();
  for (const x of current) map.set(keyOf(x), x);
  for (const y of incoming) {
    const k = keyOf(y);
    const prev = map.get(k);
    map.set(k, prev && merge ? merge(prev, y) : y);
  }
  return [...map.values()];
}

/** 客户合并：保留原有的获客渠道(source)，只更新新订单里更可信的字段。 */
function mergeCustomer(old: any, inc: any): any {
  return {
    ...old,
    email: inc.email || old.email,
    country: inc.country && inc.country !== 'N/A' ? inc.country : old.country,
    name: inc.name || old.name,
    phone: inc.phone || old.phone,
    tags: Array.isArray(inc.tags) ? inc.tags : old.tags,
  };
}

async function run(cfg: ShopifyConfig) {
  const startedAtMs = Date.now();
  const st: SyncStatus = { ...IDLE, mode: 'full', state: 'running', startedAt: new Date().toISOString(), warnings: [] };
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
      syncCursor: new Date(startedAtMs).toISOString(),
      shop: cfg.shop,
      products,
      customers: [...customers.values()],
      orders,
      abandons,
    };
    await writeShopifyCache(payload, payload.syncedAt);

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

/**
 * 增量同步：只拉取自上次基线以来 updated_at 变化的商品与订单，按 id 合并进现有缓存。
 * 商品/订单/客户可增量；弃购(checkout)没有可靠的 updated_at 过滤，保留原值，由全量同步刷新。
 * 没有基线缓存时自动退化为全量同步。
 */
async function runIncremental(cfg: ShopifyConfig): Promise<void> {
  const cache = await readCachePayload();
  if (!cache) {
    await run(cfg);
    return;
  }

  const startedAtMs = Date.now();
  const st: SyncStatus = { ...IDLE, mode: 'incremental', state: 'running', startedAt: new Date().toISOString(), warnings: [] };
  const step = (s: string) => {
    st.step = s;
    writeStatus(st);
  };
  try {
    const cursorIso = typeof cache.syncCursor === 'string' ? cache.syncCursor : cache.syncedAt;
    const cursorMs = Date.parse(cursorIso);
    const sinceMs = Number.isFinite(cursorMs) ? cursorMs - CURSOR_SAFETY_MS : startedAtMs - 24 * 3600_000;
    const since = new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, 'Z');

    step(`拉取更新的商品(自 ${since})…`);
    const changedProducts = buildProducts(await runBulk(cfg, productQSince(since), '商品(增量)', step));

    step('拉取更新的订单…');
    const { orders: changedOrders, customers: changedCustomerMap } = buildOrders(
      await runBulk(cfg, orderQSince(since), '订单(增量)', step),
      changedProducts,
    );
    const changedCustomers = [...changedCustomerMap.values()];

    const products = upsertById<any>(cache.products, changedProducts, (p) => p.id);
    const orders = upsertById<any>(cache.orders, changedOrders, (o) => o.id).sort((a, b) => a.t - b.t);
    const customers = upsertById<any>(cache.customers, changedCustomers, (c) => c.id, mergeCustomer);

    step('写入缓存…');
    const payload = {
      ...cache,
      syncedAt: new Date().toISOString(),
      // 游标回退安全余量，宁可下次多拉一点，也不漏掉变更
      syncCursor: new Date(startedAtMs - CURSOR_SAFETY_MS).toISOString(),
      shop: cfg.shop,
      products,
      orders,
      customers,
      abandons: Array.isArray(cache.abandons) ? cache.abandons : [],
    };
    await writeShopifyCache(payload, payload.syncedAt);

    st.state = 'done';
    st.step = '完成';
    st.counts = {
      changedProducts: changedProducts.length,
      changedOrders: changedOrders.length,
      changedCustomers: changedCustomers.length,
      products: products.length,
      orders: orders.length,
      customers: customers.length,
      abandons: payload.abandons.length,
    };
  } catch (e: any) {
    st.state = 'error';
    st.error = e?.message || String(e);
  } finally {
    st.finishedAt = new Date().toISOString();
    writeStatus(st);
    (globalThis as any).__opsSyncRunning = false;
  }
}

export async function startSync(mode: 'full' | 'incremental' = 'full'): Promise<{ started: boolean; message: string }> {
  const g = globalThis as any;
  if (g.__opsSyncRunning) return { started: false, message: '同步正在进行中' };
  const cfg = await shopifyConfig();
  if (!cfg) return { started: false, message: '未配置 Shopify 店铺域名 / Admin Token' };
  g.__opsSyncRunning = true;
  if (mode === 'incremental') void runIncremental(cfg);
  else void run(cfg);
  return { started: true, message: mode === 'incremental' ? '已开始增量更新' : '已开始同步' };
}
