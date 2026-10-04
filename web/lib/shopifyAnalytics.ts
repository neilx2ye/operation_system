// 站内分析的真实数据源：调用 Shopify Admin API 的 ShopifyQL 分析查询，
// 取会话 / 转化率 / 跳出率 / 销售额 / 订单，按渠道(referrer_source)、落地页、国家分组。
// 需要 read_reports(或 read_analytics) 权限。
// 注意：ShopifyQL 不提供购买漏斗、设备、LCP、加购率等埋点指标，这些无法用 Shopify 数据替代。

import { shopifyConfig, type ShopifyConfig } from '@/lib/shopifyFulfill';

type Row = Record<string, string>;

export type SiteDaily = { iso: string; sessions: number; orders: number; revenue: number; cvr: number; bounce: number };
export type SiteChannel = { channel: string; sessions: number; cvr: number; bounce: number };
export type SiteLanding = { path: string; sessions: number; cvr: number };
export type SiteCountry = { name: string; revenue: number; orders: number };
export type SiteTotals = { sessions: number; orders: number; revenue: number; cvr: number; aov: number; bounce: number };
export type SiteAnalytics = {
  from: string;
  to: string;
  daily: SiteDaily[];
  channels: SiteChannel[];
  landings: SiteLanding[];
  countries: SiteCountry[];
  totals: SiteTotals;
  prev: SiteTotals;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const CHANNEL_LABEL: Record<string, string> = {
  direct: '直接访问',
  social: '社交',
  search: '搜索',
  email: '邮件',
  other: '其他',
  unknown: '未知',
};
const COUNTRY_LABEL: Record<string, string> = {
  'United States': '美国',
  'United Kingdom': '英国',
  Canada: '加拿大',
  Australia: '澳大利亚',
  Japan: '日本',
  Germany: '德国',
  France: '法国',
  Singapore: '新加坡',
  'Hong Kong SAR': '中国香港',
  China: '中国',
};

async function runShopifyQL(cfg: ShopifyConfig, query: string): Promise<Row[]> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://${cfg.shop}/admin/api/${cfg.version}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': cfg.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'query($q: String!){ shopifyqlQuery(query: $q){ parseErrors tableData { columns { name } rows } } }',
        variables: { q: query },
      }),
      signal: AbortSignal.timeout(30000),
    });
    const json: any = await res.json().catch(() => null);
    const throttled = res.status === 429 || JSON.stringify(json?.errors ?? '').includes('THROTTLED');
    if (throttled && attempt < 6) {
      await sleep(1200 * (attempt + 1));
      continue;
    }
    if (!res.ok || !json) throw new Error('Shopify HTTP ' + res.status);
    if (json.errors?.length) throw new Error('ShopifyQL: ' + JSON.stringify(json.errors).slice(0, 400));
    const r = json.data?.shopifyqlQuery;
    if (!r) throw new Error('ShopifyQL 无返回');
    if (r.parseErrors?.length) throw new Error('ShopifyQL 解析错误: ' + JSON.stringify(r.parseErrors).slice(0, 300));
    return r.tableData?.rows ?? [];
  }
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000) + 1;
}

function totalsOf(daily: SiteDaily[]): SiteTotals {
  const sessions = daily.reduce((s, r) => s + r.sessions, 0);
  const orders = daily.reduce((s, r) => s + r.orders, 0);
  const revenue = daily.reduce((s, r) => s + r.revenue, 0);
  const bounce = sessions ? daily.reduce((s, r) => s + r.bounce * r.sessions, 0) / sessions : 0;
  return { sessions, orders, revenue, cvr: sessions ? orders / sessions : 0, aov: orders ? revenue / orders : 0, bounce };
}

const MEM = new Map<string, { at: number; data: SiteAnalytics }>();
const TTL = 5 * 60_000;

/** 按日期区间查询站内分析（含等长上一区间对比）。from/to 为 YYYY-MM-DD。 */
export async function siteAnalytics(from: string, to: string): Promise<SiteAnalytics> {
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) throw new Error('日期格式应为 YYYY-MM-DD，且 from ≤ to');
  const key = from + '|' + to;
  const hit = MEM.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;

  const cfg = await shopifyConfig();
  if (!cfg) throw new Error('未配置 Shopify 店铺域名 / Admin Token');

  const n = daysBetween(from, to);
  const prevFrom = addDays(from, -n);
  const prevTo = addDays(from, -1);

  const sessDaily = await runShopifyQL(cfg, `FROM sessions SHOW sessions, conversion_rate, bounce_rate TIMESERIES DAY SINCE ${from} UNTIL ${to}`);
  const salesDaily = await runShopifyQL(cfg, `FROM sales SHOW total_sales, orders TIMESERIES DAY SINCE ${from} UNTIL ${to}`);
  const channels = await runShopifyQL(cfg, `FROM sessions SHOW sessions, conversion_rate, bounce_rate GROUP BY referrer_source SINCE ${from} UNTIL ${to} ORDER BY sessions DESC LIMIT 20`);
  const landings = await runShopifyQL(cfg, `FROM sessions SHOW sessions, conversion_rate GROUP BY landing_page_path SINCE ${from} UNTIL ${to} ORDER BY sessions DESC LIMIT 12`);
  const countries = await runShopifyQL(cfg, `FROM sales SHOW total_sales, orders GROUP BY billing_country SINCE ${from} UNTIL ${to} ORDER BY total_sales DESC LIMIT 12`);
  const prevSess = await runShopifyQL(cfg, `FROM sessions SHOW sessions, bounce_rate SINCE ${prevFrom} UNTIL ${prevTo}`);
  const prevSales = await runShopifyQL(cfg, `FROM sales SHOW total_sales, orders SINCE ${prevFrom} UNTIL ${prevTo}`);

  const sessByDay = new Map(sessDaily.map((r) => [r.day, r]));
  const salesByDay = new Map(salesDaily.map((r) => [r.day, r]));
  const daily: SiteDaily[] = [];
  for (let iso = from; iso <= to; iso = addDays(iso, 1)) {
    const s = sessByDay.get(iso);
    const sa = salesByDay.get(iso);
    daily.push({
      iso,
      sessions: num(s?.sessions),
      cvr: num(s?.conversion_rate),
      bounce: num(s?.bounce_rate),
      orders: num(sa?.orders),
      revenue: num(sa?.total_sales),
    });
  }

  const ps = prevSess[0] ?? {};
  const psa = prevSales[0] ?? {};
  const prevSessions = num(ps.sessions);
  const prevOrders = num(psa.orders);
  const prevRevenue = num(psa.total_sales);
  const prev: SiteTotals = {
    sessions: prevSessions,
    orders: prevOrders,
    revenue: prevRevenue,
    cvr: prevSessions ? prevOrders / prevSessions : 0,
    aov: prevOrders ? prevRevenue / prevOrders : 0,
    bounce: num(ps.bounce_rate),
  };

  const data: SiteAnalytics = {
    from,
    to,
    daily,
    channels: channels.map((r) => ({
      channel: r.referrer_source ? CHANNEL_LABEL[r.referrer_source] ?? r.referrer_source : '其他',
      sessions: num(r.sessions),
      cvr: num(r.conversion_rate),
      bounce: num(r.bounce_rate),
    })),
    landings: landings.map((r) => ({ path: r.landing_page_path, sessions: num(r.sessions), cvr: num(r.conversion_rate) })),
    countries: countries.map((r) => ({ name: COUNTRY_LABEL[r.billing_country] ?? r.billing_country, revenue: num(r.total_sales), orders: num(r.orders) })),
    totals: totalsOf(daily),
    prev,
  };
  MEM.set(key, { at: Date.now(), data });
  return data;
}