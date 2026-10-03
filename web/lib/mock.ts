// OPS 数据源：优先读取 data/shopify-cache.json（Shopify 全量同步的产物）作为真实数据源，
// 缓存不存在时退回确定性伪随机的 Mock 数据。
// 同步写盘后（缓存文件 mtime 变化）按需重建内存数据，因此同步完成后无需重启服务即可看到真实数据。
// 聚合逻辑与 Mock 时期保持一致，只替换顶部数据来源。

import fs from 'node:fs';
import path from 'node:path';

type CachedCustomer = Customer & { name?: string; phone?: string; tags?: string[] };
type CachedOrder = Order & {
  shipping?: { name: string; phone: string; line1: string; line2: string; city: string; state: string; zip: string; country: string };
  /** Shopify 同步得到的物流/履约状态；旧缓存缺失时由页面按本地运单记录补齐。 */
  logisticsStatus?: string;
};
type ShopifyCache = {
  syncedAt?: string;
  shop?: string;
  products: Product[];
  customers: CachedCustomer[];
  orders: CachedOrder[];
  abandons: Abandon[];
};
const SHOPIFY_CACHE_FILE = path.join(process.cwd(), 'data', 'shopify-cache.json');

const DAY = 86_400_000;

function rng(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

let NOW = Date.now();
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

// ---------- 数据模型 ----------

export type ProductStatus = 'active' | 'draft' | 'archived';

export type Product = {
  id: string;
  /** 展示名：多变体 SPU 为「产品名 - 变体名」，单变体为产品名 */
  title: string;
  /** SPU 产品名 */
  spu: string;
  /** 变体名（单变体产品为空串） */
  variant: string;
  /** SKU 编码 */
  sku: string;
  /** Shopify 商品/变体图片；Mock 或旧缓存可能为空。 */
  imageUrl?: string;
  /** 单件重量(克),0 表示未填写;推云途订单时按 数量 × 单件重量 汇总包裹重量 */
  weightG: number;
  /** 当前库存件数 */
  stock: number;
  /** 补货点：库存 ≤ 该值时提示补货 */
  reorderPoint: number;
  /** 供货周期（天） */
  leadTimeDays: number;
  supplier: string;
  status: ProductStatus;
  category: string;
  price: number;
  cost: number;
  /** 该产品的退款概率（仅用于生成 mock 数据） */
  refundProb: number;
  /** 被抽中作为首购商品的权重（仅用于生成 mock 数据） */
  pop: number;
};

export type Customer = {
  id: string;
  email: string;
  country: string;
  source: string;
  /** Shopify 同步缓存中的 Customer.tags；Mock 数据为空。 */
  tags?: string[];
};

export type Abandon = {
  customerId: string;
  t: number;
  value: number;
  items: { productId: string; qty: number }[];
};

export type OrderItem = {
  productId: string;
  qty: number;
  price: number;
  refunded: boolean;
  refundAt: number | null;
  /** 下单时的 Item 名称与图片，避免商品后续改名/删除后列表失真。 */
  title?: string;
  imageUrl?: string;
};

export type Order = {
  id: string;
  customerId: string;
  /** 下单时间戳 */
  t: number;
  items: OrderItem[];
};

// ---------- Mock 数据源（缓存缺失时使用） ----------

// [SPU 产品名, 变体名(单变体留空), 类目, 售价, 成本, 退款概率, 热度]
// 每个 SKU 是一行；多变体 SPU 的展示名 = 「产品名 - 变体名」
const PRODUCT_DEFS: [string, string, string, number, number, number, number][] = [
  ['Oolong Tea 100g', '', 'Tea', 18, 6, 0.03, 5],
  ['Tea Infuser Bottle', '350ml', 'Drinkware', 24, 9, 0.08, 2],
  ['Tea Infuser Bottle', '500ml', 'Drinkware', 28, 11, 0.08, 2],
  ['Matcha Powder 50g', '', 'Tea', 26, 10, 0.04, 4],
  ['Bamboo Whisk', '', 'Tools', 15, 4, 0.05, 2],
  ['Pour-over Kettle', 'Matte Black', 'Coffee', 49, 22, 0.07, 2],
  ['Pour-over Kettle', 'Stainless', 'Coffee', 52, 24, 0.06, 1],
  ['Ceramic Dripper', 'White', 'Coffee', 32, 12, 0.1, 2],
  ['Ceramic Dripper', 'Black', 'Coffee', 32, 12, 0.09, 1],
  ['Coffee Beans 250g', 'Medium Roast', 'Coffee', 21, 8, 0.02, 4],
  ['Coffee Beans 250g', 'Dark Roast', 'Coffee', 21, 8, 0.02, 2],
  ['Paper Filters 100pc', '', 'Coffee', 9, 2, 0.01, 4],
  ['Glass Teapot', '600ml', 'Drinkware', 38, 15, 0.14, 1],
  ['Glass Teapot', '900ml', 'Drinkware', 45, 18, 0.12, 1],
  ['Teacup Set of 4', 'Blue', 'Drinkware', 29, 11, 0.12, 1],
  ['Teacup Set of 4', 'Green', 'Drinkware', 29, 11, 0.12, 1],
  ['Hand Grinder', '', 'Coffee', 64, 30, 0.09, 2],
  ['Travel Mug', 'Black', 'Drinkware', 22, 8, 0.06, 2],
  ['Travel Mug', 'White', 'Drinkware', 22, 8, 0.06, 1],
  ['Jasmine Tea 100g', '', 'Tea', 16, 5, 0.03, 4],
  ['Gift Box Set', '', 'Gifts', 55, 24, 0.05, 2],
  ['Digital Scale', '', 'Tools', 27, 11, 0.18, 2],
  ['Cold Brew Pitcher', '', 'Coffee', 31, 12, 0.07, 2],
];

const MOCK_PRODUCTS: Product[] = PRODUCT_DEFS.map((d, i) => ({
  id: 'p' + (i + 1),
  title: d[1] ? d[0] + ' - ' + d[1] : d[0],
  spu: d[0],
  variant: d[1],
  category: d[2],
  price: d[3],
  cost: d[4],
  refundProb: d[5],
  pop: d[6],
  sku: 'OPS-' + String(i + 1).padStart(3, '0'),
  weightG: 0,
  stock: (i * 53 + 17) % 170,
  reorderPoint: 30,
  leadTimeDays: 14 + (i % 3) * 7,
  supplier: 'Supplier ' + 'ABC'[i % 3],
  status: 'active' as ProductStatus,
}));

// ---------- 数据来源（Shopify 缓存优先，文件变化时重建） ----------

function loadShopifyCache(): ShopifyCache | null {
  try {
    const raw = JSON.parse(fs.readFileSync(SHOPIFY_CACHE_FILE, 'utf8'));
    if (!Array.isArray(raw?.products) || !Array.isArray(raw?.customers) || !Array.isArray(raw?.orders) || !Array.isArray(raw?.abandons)) return null;
    return raw as ShopifyCache;
  } catch {
    return null;
  }
}

let dataMtime = -1;
let shopifyCache: ShopifyCache | null = null;
export let DATA_SOURCE: 'shopify' | 'mock' = 'mock';
export let PRODUCTS: Product[] = MOCK_PRODUCTS;
export let CUSTOMERS: Customer[] = [];
let ALL_CUSTOMERS: Customer[] = [];
let ORDERS: CachedOrder[] = [];
let ABANDONS: Abandon[] = [];
let CATALOG_DEFAULTS: Record<string, Required<CatalogPatch>> = {};

function cacheMtime(): number {
  try {
    return fs.statSync(SHOPIFY_CACHE_FILE).mtimeMs;
  } catch {
    return 0;
  }
}

/** 缓存文件变化（例如刚完成 Shopify 同步）时重建内存里的数据与派生聚合 */
function ensureData() {
  const m = cacheMtime();
  if (m === dataMtime) return;
  dataMtime = m;
  rebuild();
}

// ---------- 产品目录（可编辑参数，持久化到 data/catalog.json，文件为准） ----------

export const CATALOG_FIELDS = ['sku', 'spu', 'variant', 'category', 'price', 'cost', 'weightG', 'stock', 'reorderPoint', 'leadTimeDays', 'supplier', 'status'] as const;
export type CatalogField = (typeof CATALOG_FIELDS)[number];
export type CatalogPatch = Partial<Pick<Product, CatalogField>>;
export type CatalogRow = Pick<Product, 'id' | 'title' | CatalogField>;

const CATALOG_FILE = path.join(process.cwd(), 'data', 'catalog.json');
let catalogMtime = -1;

const pickFields = (p: Product): Required<CatalogPatch> => ({
  sku: p.sku,
  spu: p.spu,
  variant: p.variant,
  category: p.category,
  price: p.price,
  cost: p.cost,
  weightG: p.weightG,
  stock: p.stock,
  reorderPoint: p.reorderPoint,
  leadTimeDays: p.leadTimeDays,
  supplier: p.supplier,
  status: p.status,
});

function sanitize(raw: Record<string, unknown>): CatalogPatch {
  const num = (v: unknown, whole = false) => {
    if (v === '' || v == null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? (whole ? Math.round(n) : r2(n)) : undefined;
  };
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);
  const out: CatalogPatch = {};
  const sku = str(raw.sku);
  if (sku) out.sku = sku;
  const spu = str(raw.spu);
  if (spu) out.spu = spu;
  const variant = str(raw.variant);
  if (variant !== undefined) out.variant = variant;
  const category = str(raw.category);
  if (category) out.category = category;
  const supplier = str(raw.supplier);
  if (supplier !== undefined) out.supplier = supplier;
  const price = num(raw.price);
  if (price !== undefined) out.price = price;
  const cost = num(raw.cost);
  if (cost !== undefined) out.cost = cost;
  const weightG = num(raw.weightG, true);
  if (weightG !== undefined) out.weightG = weightG;
  const stock = num(raw.stock, true);
  if (stock !== undefined) out.stock = stock;
  const reorderPoint = num(raw.reorderPoint, true);
  if (reorderPoint !== undefined) out.reorderPoint = reorderPoint;
  const leadTimeDays = num(raw.leadTimeDays, true);
  if (leadTimeDays !== undefined) out.leadTimeDays = leadTimeDays;
  if (raw.status === 'active' || raw.status === 'draft' || raw.status === 'archived') out.status = raw.status;
  return out;
}

function readOverrides(): Record<string, CatalogPatch> {
  try {
    const j = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function applyPatch(p: Product, patch: CatalogPatch) {
  Object.assign(p, patch);
  p.title = p.variant ? p.spu + ' - ' + p.variant : p.spu;
}

/** 文件有变化时，把目录参数同步到内存中的 PRODUCTS（分析聚合用的成本/名称随之更新） */
export function syncCatalog() {
  let m = 0;
  try {
    m = fs.statSync(CATALOG_FILE).mtimeMs;
  } catch {
    m = 0;
  }
  if (m === catalogMtime) return;
  catalogMtime = m;
  const ov = readOverrides();
  PRODUCTS.forEach((p) => {
    applyPatch(p, CATALOG_DEFAULTS[p.id]);
    if (ov[p.id]) applyPatch(p, sanitize(ov[p.id] as Record<string, unknown>));
  });
}

export function catalogRows(): CatalogRow[] {
  ensureData();
  syncCatalog();
  return PRODUCTS.map((p) => ({ id: p.id, title: p.title, ...pickFields(p) }));
}

/** 批量更新：{ 产品id: { 字段: 值 } }。校验失败会抛错且不写文件。返回更新的 SKU 数。 */
export function updateCatalog(patches: Record<string, Record<string, unknown>>): number {
  ensureData();
  syncCatalog();
  const ov = readOverrides();
  let n = 0;
  for (const [id, raw] of Object.entries(patches)) {
    if (!pById[id] || !raw || typeof raw !== 'object') continue;
    const clean = sanitize(raw);
    if (!Object.keys(clean).length) continue;
    ov[id] = { ...(ov[id] || {}), ...clean };
    n++;
  }
  const seen = new Set<string>();
  for (const p of PRODUCTS) {
    const s = ov[p.id]?.sku ?? CATALOG_DEFAULTS[p.id].sku;
    if (seen.has(s)) throw new Error('SKU 编码重复：' + s);
    seen.add(s);
  }
  fs.mkdirSync(path.dirname(CATALOG_FILE), { recursive: true });
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(ov, null, 2));
  catalogMtime = -1;
  syncCatalog();
  return n;
}

// ---------- Mock 生成（仅缓存缺失时使用） ----------

const COUNTRIES = ['US', 'US', 'US', 'US', 'CA', 'UK', 'UK', 'AU', 'DE'];
const SOURCES = ['google', 'google', 'meta', 'meta', 'tiktok', 'organic', 'email'];

function buildMock(): { products: Product[]; customers: Customer[]; allCustomers: Customer[]; orders: Order[]; abandons: Abandon[] } {
  const rand = rng(42);
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rand() * a.length)];

  const products: Product[] = MOCK_PRODUCTS.map((p) => ({ ...p }));

  const customers: Customer[] = Array.from({ length: 150 }, (_, i) => ({
    id: 'c' + (i + 1),
    email: 'user' + (i + 1) + '@example.com',
    country: pick(COUNTRIES),
    source: pick(SOURCES),
  }));

  const weightedPool: number[] = [];
  products.forEach((p, i) => {
    for (let k = 0; k < p.pop; k++) weightedPool.push(i);
  });

  const orders: Order[] = [];
  customers.forEach((c) => {
    const n = 1 + (rand() < 0.3 ? 1 + Math.floor(rand() * 3) : 0);
    let t = NOW - Math.floor(rand() * 170) * DAY - Math.floor(rand() * DAY);
    for (let k = 0; k < n && t <= NOW; k++) {
      const first = pick(weightedPool);
      const idx = [first];
      if (rand() < 0.35) {
        const mate = first ^ 1;
        if (mate < products.length && products[mate].spu !== products[first].spu) idx.push(mate);
      } else if (rand() < 0.2) idx.push(pick(weightedPool));
      const items: OrderItem[] = [...new Set(idx)].map((i) => {
        const p = products[i];
        const qty = rand() < 0.15 ? 2 : 1;
        const refunded = rand() < p.refundProb;
        const refundAt = refunded ? Math.min(NOW, t + (3 + Math.floor(rand() * 12)) * DAY) : null;
        return { productId: p.id, qty, price: p.price, refunded, refundAt };
      });
      orders.push({ id: '', customerId: c.id, t, items });
      t += (10 + Math.floor(rand() * 50)) * DAY;
    }
  });
  orders.sort((a, b) => a.t - b.t);
  orders.forEach((o, i) => {
    o.id = '#' + (1001 + i);
  });

  // 弃购：leads 是只弃购、从未下单的潜在用户；老客也可能有弃购记录（不影响上面已生成的订单数据）
  const leads: Customer[] = Array.from({ length: 45 }, (_, i) => ({
    id: 'l' + (i + 1),
    email: 'lead' + (i + 1) + '@example.com',
    country: pick(COUNTRIES),
    source: pick(SOURCES),
  }));

  const abandons: Abandon[] = [];
  const makeAbandon = (customerId: string, t: number) => {
    const first = pick(weightedPool);
    const items = [{ productId: products[first].id, qty: rand() < 0.2 ? 2 : 1 }];
    if (rand() < 0.3) {
      const second = pick(weightedPool);
      if (second !== first) items.push({ productId: products[second].id, qty: 1 });
    }
    const value = items.reduce((s, it) => s + it.qty * products[Number(it.productId.slice(1)) - 1].price, 0);
    abandons.push({ customerId, t, value, items });
  };

  leads.forEach((l) => {
    const n = rand() < 0.3 ? 2 : 1;
    for (let k = 0; k < n; k++) makeAbandon(l.id, NOW - Math.floor(rand() * 60) * DAY - Math.floor(rand() * DAY));
  });
  customers.forEach((c) => {
    if (rand() < 0.2) makeAbandon(c.id, NOW - Math.floor(rand() * 120) * DAY - Math.floor(rand() * DAY));
  });
  abandons.sort((a, b) => a.t - b.t);

  return { products, customers, allCustomers: [...customers, ...leads], orders, abandons };
}

// ---------- 派生聚合状态 ----------

let pById: Record<string, Product> = {};
let cById: Record<string, Customer> = {};

type ProductStats = {
  units: number;
  gross: number;
  refUnits: number;
  refAmt: number;
  buyers: Map<string, BuyerStat>;
  weekly: number[];
  r30: number;
  p30: number;
};
type BuyerStat = { orders: number; units: number; amount: number };
type CustomerStats = {
  orders: number;
  gross: number;
  refAmt: number;
  refunds: number;
  first: number | null;
  last: number | null;
  products: Map<string, { units: number; amount: number }>;
};

const WEEKS = 26;

let PS: Record<string, ProductStats> = {};
let CS: Record<string, CustomerStats> = {};
let custSets: Record<string, Set<string>> = {};
let pairCount: Record<string, number> = {};
let prodCust: Record<string, number> = {};
let AB: Record<string, Abandon[]> = {};

function rebuild() {
  const cache = loadShopifyCache();
  shopifyCache = cache;
  NOW = Date.now();

  if (cache) {
    DATA_SOURCE = 'shopify';
    PRODUCTS = cache.products;
    CUSTOMERS = cache.customers;
    ALL_CUSTOMERS = cache.customers;
    ORDERS = cache.orders;
    ABANDONS = cache.abandons;
  } else {
    const m = buildMock();
    DATA_SOURCE = 'mock';
    PRODUCTS = m.products;
    CUSTOMERS = m.customers;
    ALL_CUSTOMERS = m.allCustomers;
    ORDERS = m.orders;
    ABANDONS = m.abandons;
  }

  CATALOG_DEFAULTS = Object.fromEntries(PRODUCTS.map((p) => [p.id, pickFields(p)]));
  catalogMtime = -1;

  pById = Object.fromEntries(PRODUCTS.map((p) => [p.id, p]));
  cById = Object.fromEntries(ALL_CUSTOMERS.map((c) => [c.id, c]));

  PS = {};
  CS = {};
  PRODUCTS.forEach((p) => {
    PS[p.id] = {
      units: 0,
      gross: 0,
      refUnits: 0,
      refAmt: 0,
      buyers: new Map(),
      weekly: Array(WEEKS).fill(0),
      r30: 0,
      p30: 0,
    };
  });
  ALL_CUSTOMERS.forEach((c) => {
    CS[c.id] = { orders: 0, gross: 0, refAmt: 0, refunds: 0, first: null, last: null, products: new Map() };
  });

  ORDERS.forEach((o) => {
    const c = CS[o.customerId];
    if (!c) return;
    c.orders++;
    if (c.first === null || o.t < c.first) c.first = o.t;
    if (c.last === null || o.t > c.last) c.last = o.t;
    const age = NOW - o.t;
    o.items.forEach((it) => {
      const s = PS[it.productId];
      if (!s) return;
      const amt = it.qty * it.price;
      const net = it.refunded ? 0 : amt;
      s.units += it.qty;
      s.gross += amt;
      if (it.refunded) {
        s.refUnits += it.qty;
        s.refAmt += amt;
        c.refunds += it.qty;
        c.refAmt += amt;
      }
      const b = s.buyers.get(o.customerId) || { orders: 0, units: 0, amount: 0 };
      b.orders++;
      b.units += it.qty;
      b.amount += net;
      s.buyers.set(o.customerId, b);
      const w = Math.floor(age / (7 * DAY));
      if (w >= 0 && w < WEEKS) s.weekly[WEEKS - 1 - w] += net;
      if (age < 30 * DAY) s.r30 += net;
      else if (age < 60 * DAY) s.p30 += net;
      c.gross += amt;
      const cp = c.products.get(it.productId) || { units: 0, amount: 0 };
      cp.units += it.qty;
      cp.amount += net;
      c.products.set(it.productId, cp);
    });
  });

  AB = {};
  ABANDONS.forEach((a) => {
    (AB[a.customerId] = AB[a.customerId] || []).push(a);
  });

  custSets = {};
  ORDERS.forEach((o) => {
    custSets[o.customerId] = custSets[o.customerId] || new Set();
    o.items.forEach((it) => custSets[o.customerId].add(it.productId));
  });

  pairCount = {};
  prodCust = {};
  Object.keys(custSets).forEach((cid) => {
    const arr = [...custSets[cid]].sort();
    arr.forEach((a) => {
      prodCust[a] = (prodCust[a] || 0) + 1;
    });
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = arr[i] + '|' + arr[j];
        pairCount[key] = (pairCount[key] || 0) + 1;
      }
    }
  });
}

/** 当前数据源概览：来源、同步时间、行数 */
export function dataSourceInfo() {
  ensureData();
  return {
    source: DATA_SOURCE,
    syncedAt: shopifyCache?.syncedAt ?? null,
    shop: shopifyCache?.shop ?? null,
    counts: { products: PRODUCTS.length, customers: ALL_CUSTOMERS.length, orders: ORDERS.length, abandons: ABANDONS.length },
  };
}

// ---------- 行视图 ----------

export type ProductRow = {
  id: string;
  title: string;
  category: string;
  price: number;
  cost: number;
  units: number;
  revenue: number;
  refundRate: number;
  profit: number;
  margin: number;
  buyers: number;
  repeatBuyers: number;
  trend30: number | null;
};

export type CustomerRow = {
  id: string;
  email: string;
  country: string;
  source: string;
  orders: number;
  ltv: number;
  refunds: number;
  firstOrder: string | null;
  lastOrder: string | null;
  daysSince: number | null;
  /** 弃购次数 / 弃购金额 / 最近弃购日期 */
  abandons: number;
  abandonValue: number;
  lastAbandon: string | null;
  /** Shopify Customer.tags；Mock 数据为空数组。 */
  shopifyTags: string[];
};

export type RelationRow = {
  a: string;
  b: string;
  aId: string;
  bId: string;
  count: number;
  lift: number;
};

export type ProductDetail = ProductRow & {
  weekly: number[];
  buyersList: { email: string; country: string; orders: number; units: number; amount: number }[];
  coProducts: { product: string; count: number; lift: number }[];
};

export type CustomerDetail = CustomerRow & {
  products: { product: string; units: number; amount: number }[];
  timeline: { date: string; type: string; text: string }[];
};

const repeatBuyersOf = (buyers: Map<string, BuyerStat>) => {
  let repeat = 0;
  buyers.forEach((b) => {
    if (b.orders > 1) repeat++;
  });
  return repeat;
};

function productRow(p: Product): ProductRow {
  const s = PS[p.id];
  const revenue = s.gross - s.refAmt;
  const profit = revenue - p.cost * (s.units - s.refUnits);
  return {
    id: p.id,
    title: p.title,
    category: p.category,
    price: p.price,
    cost: p.cost,
    units: s.units,
    revenue: r2(revenue),
    refundRate: s.units ? r3(s.refUnits / s.units) : 0,
    profit: r2(profit),
    margin: revenue ? r3(profit / revenue) : 0,
    buyers: s.buyers.size,
    repeatBuyers: repeatBuyersOf(s.buyers),
    trend30: s.p30 ? r3((s.r30 - s.p30) / s.p30) : null,
  };
}

type Range = { from: number; to: number };

function agg(pid: string, from: number, to: number) {
  const s = { units: 0, refUnits: 0, refAmt: 0, net: 0, buyers: new Map<string, BuyerStat>() };
  ORDERS.forEach((o) => {
    if (o.t < from || o.t > to) return;
    o.items.forEach((it) => {
      if (it.productId !== pid) return;
      const amt = it.qty * it.price;
      const net = it.refunded ? 0 : amt;
      s.units += it.qty;
      s.net += net;
      if (it.refunded) {
        s.refUnits += it.qty;
        s.refAmt += amt;
      }
      const b = s.buyers.get(o.customerId) || { orders: 0, units: 0, amount: 0 };
      b.orders++;
      b.units += it.qty;
      b.amount += net;
      s.buyers.set(o.customerId, b);
    });
  });
  return s;
}

function productRowR(p: Product, from: number, to: number): ProductRow {
  const s = agg(p.id, from, to);
  const revenue = s.net;
  const profit = revenue - p.cost * (s.units - s.refUnits);
  const len = to - from;
  const prev = agg(p.id, from - len - 1, from - 1);
  return {
    id: p.id,
    title: p.title,
    category: p.category,
    price: p.price,
    cost: p.cost,
    units: s.units,
    revenue: r2(revenue),
    refundRate: s.units ? r3(s.refUnits / s.units) : 0,
    profit: r2(profit),
    margin: revenue ? r3(profit / revenue) : 0,
    buyers: s.buyers.size,
    repeatBuyers: repeatBuyersOf(s.buyers),
    trend30: prev.net ? r3((s.net - prev.net) / prev.net) : null,
  };
}

export function parseRange(from?: string | null, to?: string | null): Range | null {
  ensureData();
  if (!from && !to) return null;
  const f = from ? new Date(from + 'T00:00:00').getTime() : ORDERS[0]?.t ?? NOW;
  const t = to ? new Date(to + 'T23:59:59.999').getTime() : Date.now();
  if (Number.isNaN(f) || Number.isNaN(t)) return null;
  return { from: f, to: t };
}

function customerRow(c: Customer): CustomerRow {
  const s = CS[c.id];
  const ab = AB[c.id] || [];
  return {
    id: c.id,
    email: c.email,
    country: c.country,
    source: c.source,
    orders: s.orders,
    ltv: r2(s.gross - s.refAmt),
    refunds: s.refunds,
    firstOrder: s.first ? new Date(s.first).toISOString().slice(0, 10) : null,
    lastOrder: s.last ? new Date(s.last).toISOString().slice(0, 10) : null,
    daysSince: s.last ? Math.floor((NOW - s.last) / DAY) : null,
    abandons: ab.length,
    abandonValue: r2(ab.reduce((sum, a) => sum + a.value, 0)),
    lastAbandon: ab.length ? new Date(ab[ab.length - 1].t).toISOString().slice(0, 10) : null,
    shopifyTags: Array.isArray(c.tags) ? c.tags : [],
  };
}

// ---------- 关联分析（共同购买） ----------

export function relations(productId?: string | null): RelationRow[] {
  ensureData();
  syncCatalog();
  const N = CUSTOMERS.length;
  return Object.keys(pairCount)
    .map((key) => {
      const [a, b] = key.split('|');
      const count = pairCount[key];
      return {
        a: pById[a].title,
        b: pById[b].title,
        aId: a,
        bId: b,
        count,
        lift: r2((count * N) / (prodCust[a] * prodCust[b])),
      };
    })
    .filter((r) => !productId || r.aId === productId || r.bId === productId)
    .sort((x, y) => y.count - x.count)
    .slice(0, 50);
}

// ---------- 详情 ----------

export function productDetail(id: string, rg?: Range | null): ProductDetail | null {
  ensureData();
  syncCatalog();
  const p = pById[id];
  if (!p) return null;
  const s = PS[id];
  const source = rg ? agg(id, rg.from, rg.to) : s;
  const buyersList = [...source.buyers.entries()]
    .map(([cid, b]) => ({
      email: cById[cid].email,
      country: cById[cid].country,
      orders: b.orders,
      units: b.units,
      amount: r2(b.amount),
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 20);
  const coProducts = relations(id)
    .slice(0, 8)
    .map((r) => ({ product: r.aId === id ? r.b : r.a, count: r.count, lift: r.lift }));
  return { ...(rg ? productRowR(p, rg.from, rg.to) : productRow(p)), weekly: s.weekly.map(r2), buyersList, coProducts };
}

export function customerDetail(id: string): CustomerDetail | null {
  ensureData();
  syncCatalog();
  const c = cById[id];
  if (!c) return null;
  const products = [...CS[id].products.entries()]
    .map(([pid, v]) => ({ product: pById[pid].title, units: v.units, amount: r2(v.amount) }))
    .sort((a, b) => b.amount - a.amount);
  const timeline: { t: number; date: string; type: string; text: string }[] = [];
  ORDERS.filter((o) => o.customerId === id).forEach((o) => {
    const total = o.items.reduce((s, it) => s + it.qty * it.price, 0);
    timeline.push({
      t: o.t,
      date: new Date(o.t).toISOString().slice(0, 10),
      type: '下单',
      text: o.id + ' · $' + r2(total) + ' · ' + o.items.map((it) => pById[it.productId].title + ' x' + it.qty).join(', '),
    });
    o.items
      .filter((it) => it.refunded)
      .forEach((it) =>
        timeline.push({
          t: it.refundAt as number,
          date: new Date(it.refundAt as number).toISOString().slice(0, 10),
          type: '退款',
          text: o.id + ' · ' + pById[it.productId].title + ' · $' + r2(it.qty * it.price),
        }),
      );
  });
  (AB[id] || []).forEach((a) =>
    timeline.push({
      t: a.t,
      date: new Date(a.t).toISOString().slice(0, 10),
      type: '弃购',
      text: '$' + r2(a.value) + ' · ' + a.items.map((it) => pById[it.productId].title + ' x' + it.qty).join(', '),
    }),
  );
  timeline.sort((a, b) => b.t - a.t);
  return {
    ...customerRow(c),
    products,
    timeline: timeline.map(({ date, type, text }) => ({ date, type, text })),
  };
}

export function allProductRows(rg?: Range | null): ProductRow[] {
  ensureData();
  syncCatalog();
  return PRODUCTS.map((p) => (rg ? productRowR(p, rg.from, rg.to) : productRow(p)));
}

export function allCustomerRows(): CustomerRow[] {
  ensureData();
  return ALL_CUSTOMERS.map(customerRow);
}

// ---------- 订单 ----------

export type OrderStatus = '已完成' | '部分退款' | '已退款';

export type OrderItemPreview = { product: string; imageUrl: string; qty: number };

export type OrderRow = {
  id: string;
  customerId: string;
  email: string;
  country: string;
  source: string;
  date: string;
  items: number;
  /** 保留给发货/后台逻辑使用，订单列表不再展示 SKU 列。 */
  skus: string;
  /** 订单列表展示的具体 Item（同一商品因退款拆分的行会重新合并数量）。 */
  orderItems: OrderItemPreview[];
  gross: number;
  refunded: number;
  net: number;
  status: OrderStatus;
  logisticsStatus: string;
};

export type OrderDetail = OrderRow & {
  profit: number;
  customer: { id: string; name: string; email: string; phone: string; country: string; source: string; orders: number; ltv: number; firstOrder: string | null };
  shipping: { name: string; phone: string; line1: string; line2: string; city: string; state: string; zip: string; country: string };
  lines: { product: string; imageUrl: string; sku: string; weightG: number; qty: number; price: number; amount: number; refunded: boolean; refundDate: string | null }[];
};

function orderStatus(o: Order): OrderStatus {
  const n = o.items.filter((it) => it.refunded).length;
  return n === 0 ? '已完成' : n === o.items.length ? '已退款' : '部分退款';
}

function orderRow(o: Order): OrderRow {
  const gross = o.items.reduce((s, it) => s + it.qty * it.price, 0);
  const refunded = o.items.reduce((s, it) => s + (it.refunded ? it.qty * it.price : 0), 0);
  const c = cById[o.customerId];
  const grouped = new Map<string, OrderItemPreview>();
  for (const it of o.items) {
    const p = pById[it.productId];
    const product = it.title || p?.title || '已删除商品';
    const imageUrl = it.imageUrl || p?.imageUrl || '';
    const key = it.productId + '\n' + product + '\n' + imageUrl;
    const hit = grouped.get(key);
    if (hit) hit.qty += it.qty;
    else grouped.set(key, { product, imageUrl, qty: it.qty });
  }
  return {
    id: o.id,
    customerId: o.customerId,
    email: c.email,
    country: c.country,
    source: c.source,
    date: new Date(o.t).toISOString().slice(0, 10),
    items: o.items.reduce((s, it) => s + it.qty, 0),
    skus: o.items.map((it) => (pById[it.productId]?.sku || '-') + ' x' + it.qty).join(', '),
    orderItems: [...grouped.values()],
    gross: r2(gross),
    refunded: r2(refunded),
    net: r2(gross - refunded),
    status: orderStatus(o),
    logisticsStatus: (o as CachedOrder).logisticsStatus || '未发货',
  };
}

export function allOrderRows(): OrderRow[] {
  ensureData();
  syncCatalog();
  return ORDERS.map(orderRow).reverse();
}

// mock 收货信息：按客户编号确定性生成（不消耗随机数，不影响已有数据）。接 Shopify 后换成订单的 shipping_address。
const FIRST_NAMES = ['Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'Lucas', 'Mia', 'Ethan', 'Sophia', 'Mason', 'Chloe', 'Leo'];
const LAST_NAMES = ['Smith', 'Johnson', 'Brown', 'Taylor', 'Wilson', 'Davies', 'Clark', 'Walker', 'Lee', 'Martin', 'Young', 'King'];
const STREETS = ['Maple St', 'Oak Ave', 'Cedar Rd', 'Pine Ln', 'Lake Dr', 'Hill St', 'River Rd', 'Park Ave'];
type Place = [city: string, state: string, zip: string];
const PLACES: Record<string, Place[]> = {
  US: [['Los Angeles', 'CA', '90012'], ['New York', 'NY', '10001'], ['Austin', 'TX', '73301'], ['Seattle', 'WA', '98101'], ['Chicago', 'IL', '60601']],
  CA: [['Toronto', 'ON', 'M5V 2T6'], ['Vancouver', 'BC', 'V6B 1A1']],
  UK: [['London', 'England', 'E1 6AN'], ['Manchester', 'England', 'M1 1AE']],
  AU: [['Sydney', 'NSW', '2000'], ['Melbourne', 'VIC', '3000']],
  DE: [['Berlin', 'BE', '10115'], ['Munich', 'BY', '80331']],
};

function shippingOf(c: Customer) {
  const n = Number(c.id.slice(1)) || 0;
  const name = FIRST_NAMES[n % FIRST_NAMES.length] + ' ' + LAST_NAMES[(n * 7) % LAST_NAMES.length];
  const places = PLACES[c.country] || PLACES.US;
  const [city, state, zip] = places[n % places.length];
  const phone = '+1 555 01' + String(n % 100).padStart(2, '0') + ' ' + String(1000 + ((n * 37) % 9000));
  return {
    name,
    phone,
    line1: 100 + ((n * 13) % 900) + ' ' + STREETS[n % STREETS.length],
    line2: n % 4 === 0 ? 'Apt ' + (1 + (n % 30)) : '',
    city,
    state,
    zip,
    country: c.country,
  };
}

export function orderDetail(id: string): OrderDetail | null {
  ensureData();
  syncCatalog();
  const o = ORDERS.find((x) => x.id === id);
  if (!o) return null;
  const lines = o.items.map((it) => ({
    product: it.title || pById[it.productId]?.title || '已删除商品',
    imageUrl: it.imageUrl || pById[it.productId]?.imageUrl || '',
    sku: pById[it.productId]?.sku || '-',
    weightG: pById[it.productId]?.weightG || 0,
    qty: it.qty,
    price: it.price,
    amount: r2(it.qty * it.price),
    refunded: it.refunded,
    refundDate: it.refundAt ? new Date(it.refundAt).toISOString().slice(0, 10) : null,
  }));
  const profit = o.items.reduce((s, it) => (it.refunded ? s : s + it.qty * (it.price - pById[it.productId].cost)), 0);
  const c = cById[o.customerId];
  const cr = customerRow(c);
  const shipping = (o as CachedOrder).shipping || shippingOf(c);
  return {
    ...orderRow(o),
    profit: r2(profit),
    customer: { id: c.id, name: shipping.name, email: c.email, phone: shipping.phone, country: c.country, source: c.source, orders: cr.orders, ltv: cr.ltv, firstOrder: cr.firstOrder },
    shipping,
    lines,
  };
}