// 站内分析 / 广告分析 的 Mock 数据（接入真实 GA4 / Shopify / 广告 API 后替换此文件即可）

export type Platform = 'Google' | 'Meta' | 'TikTok';

export type DayPoint = {
  iso: string; // YYYY-MM-DD（本地时区）
  date: string;
  sessions: number;
  orders: number;
  revenue: number; // Shopify 实际销售额
  spend: number;
  platformRevenue: number; // 平台后台归因销售额
};

export type ChannelRow = {
  channel: string;
  kind: 'paid' | 'free';
  sessions: number;
  newRate: number;
  bounce: number;
  pagesPerSession: number;
  addToCartRate: number;
  cvr: number;
  orders: number;
  revenue: number;
};

export type LandingRow = {
  path: string;
  sessions: number;
  bounce: number;
  firstScreenLoss: number;
  addToCartRate: number;
  cvr: number;
  mobileShare: number;
  lcp: number; // 秒
};

export type FunnelStep = { step: string; mobile: number; desktop: number };

export type CampaignRow = {
  id: string;
  platform: Platform;
  campaign: string;
  spend: number;
  impressions: number;
  clicks: number;
  orders: number;
  platformRevenue: number;
  newCustomerRate: number;
  frequency: number;
  ctrTrend: number; // CTR 近7天相对前7天
};

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

export function buildDaily(days = 90): DayPoint[] {
  const r = rng(42);
  const out: DayPoint[] = [];
  const end = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(end.getDate() - i);
    const wk = d.getDay() === 0 || d.getDay() === 6 ? 1.15 : 1;
    const sessions = Math.round((1800 + r() * 500 + (days - i) * 12) * wk);
    const cvr = 0.021 + r() * 0.008 - (i < 8 ? 0.004 : 0); // 近一周转化率下滑，用于演示异常
    const orders = Math.round(sessions * cvr);
    const revenue = orders * (62 + r() * 14);
    const spend = 520 + r() * 160 + (days - i) * 3;
    const platformRevenue = spend * (2.6 + r() * 0.8) * 1.0;
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push({ iso, date: iso.slice(5), sessions, orders, revenue, spend, platformRevenue });
  }
  return out;
}

export const CHANNELS: ChannelRow[] = [
  { channel: 'Google Shopping', kind: 'paid', sessions: 14200, newRate: 0.71, bounce: 0.46, pagesPerSession: 3.9, addToCartRate: 0.089, cvr: 0.031, orders: 440, revenue: 29800 },
  { channel: 'Google Search', kind: 'paid', sessions: 9800, newRate: 0.64, bounce: 0.41, pagesPerSession: 4.3, addToCartRate: 0.101, cvr: 0.036, orders: 353, revenue: 24900 },
  { channel: 'Meta', kind: 'paid', sessions: 18600, newRate: 0.83, bounce: 0.63, pagesPerSession: 2.6, addToCartRate: 0.052, cvr: 0.016, orders: 298, revenue: 18400 },
  { channel: 'TikTok', kind: 'paid', sessions: 12100, newRate: 0.9, bounce: 0.72, pagesPerSession: 2.1, addToCartRate: 0.037, cvr: 0.009, orders: 109, revenue: 6200 },
  { channel: 'Email / SMS', kind: 'free', sessions: 4300, newRate: 0.12, bounce: 0.33, pagesPerSession: 4.8, addToCartRate: 0.134, cvr: 0.058, orders: 249, revenue: 19300 },
  { channel: 'Organic Search', kind: 'free', sessions: 6900, newRate: 0.78, bounce: 0.49, pagesPerSession: 3.4, addToCartRate: 0.066, cvr: 0.019, orders: 131, revenue: 8700 },
  { channel: 'Direct', kind: 'free', sessions: 5200, newRate: 0.38, bounce: 0.38, pagesPerSession: 4.1, addToCartRate: 0.098, cvr: 0.033, orders: 172, revenue: 12100 },
];

export const LANDINGS: LandingRow[] = [
  { path: '/', sessions: 11800, bounce: 0.44, firstScreenLoss: 0.24, addToCartRate: 0.071, cvr: 0.022, mobileShare: 0.68, lcp: 2.4 },
  { path: '/collections/best-sellers', sessions: 9300, bounce: 0.4, firstScreenLoss: 0.2, addToCartRate: 0.092, cvr: 0.029, mobileShare: 0.71, lcp: 2.1 },
  { path: '/products/tea-sampler', sessions: 8100, bounce: 0.52, firstScreenLoss: 0.31, addToCartRate: 0.083, cvr: 0.027, mobileShare: 0.77, lcp: 3.6 },
  { path: '/pages/tiktok-offer', sessions: 7400, bounce: 0.74, firstScreenLoss: 0.48, addToCartRate: 0.031, cvr: 0.006, mobileShare: 0.93, lcp: 4.2 },
  { path: '/products/gift-set', sessions: 6200, bounce: 0.47, firstScreenLoss: 0.26, addToCartRate: 0.097, cvr: 0.034, mobileShare: 0.64, lcp: 2.2 },
  { path: '/blogs/brewing-guide', sessions: 3900, bounce: 0.61, firstScreenLoss: 0.35, addToCartRate: 0.028, cvr: 0.008, mobileShare: 0.59, lcp: 1.9 },
];

export const FUNNEL: FunnelStep[] = [
  { step: '会话', mobile: 41200, desktop: 20100 },
  { step: '浏览商品', mobile: 23600, desktop: 13300 },
  { step: '加入购物车', mobile: 2950, desktop: 2080 },
  { step: '开始结账', mobile: 1420, desktop: 1290 },
  { step: '填写支付', mobile: 760, desktop: 980 },
  { step: '完成购买', mobile: 520, desktop: 840 },
];

export const COUNTRIES = [
  { name: '美国', sessions: 31400, cvr: 0.027 },
  { name: '加拿大', sessions: 6200, cvr: 0.024 },
  { name: '英国', sessions: 5100, cvr: 0.019 },
  { name: '澳大利亚', sessions: 3800, cvr: 0.021 },
  { name: '其他', sessions: 14600, cvr: 0.012 },
];

export const CAMPAIGNS: CampaignRow[] = [
  { id: 'g1', platform: 'Google', campaign: 'Shopping - Best Sellers', spend: 5200, impressions: 910000, clicks: 14200, orders: 440, platformRevenue: 19800, newCustomerRate: 0.69, frequency: 1.4, ctrTrend: 0.02 },
  { id: 'g2', platform: 'Google', campaign: 'Search - Brand', spend: 1100, impressions: 120000, clicks: 6100, orders: 260, platformRevenue: 15400, newCustomerRate: 0.22, frequency: 1.1, ctrTrend: 0.0 },
  { id: 'g3', platform: 'Google', campaign: 'Search - Generic Tea', spend: 3400, impressions: 380000, clicks: 3700, orders: 93, platformRevenue: 8300, newCustomerRate: 0.81, frequency: 1.2, ctrTrend: -0.04 },
  { id: 'm1', platform: 'Meta', campaign: 'ASC - Prospecting', spend: 6800, impressions: 1650000, clicks: 12400, orders: 210, platformRevenue: 17200, newCustomerRate: 0.86, frequency: 2.1, ctrTrend: -0.09 },
  { id: 'm2', platform: 'Meta', campaign: 'Retargeting - ATC 14d', spend: 1900, impressions: 420000, clicks: 6200, orders: 150, platformRevenue: 11800, newCustomerRate: 0.08, frequency: 5.8, ctrTrend: -0.22 },
  { id: 't1', platform: 'TikTok', campaign: 'Spark - UGC Sampler', spend: 4300, impressions: 2900000, clicks: 12100, orders: 120, platformRevenue: 7900, newCustomerRate: 0.92, frequency: 1.9, ctrTrend: -0.15 },
  { id: 't2', platform: 'TikTok', campaign: 'TopView - Offer', spend: 2600, impressions: 1700000, clicks: 6800, orders: 28, platformRevenue: 1900, newCustomerRate: 0.95, frequency: 1.5, ctrTrend: -0.06 },
];

// 各落地页的渠道流量构成权重，顺序与 CHANNELS 一致：
// Google Shopping / Google Search / Meta / TikTok / Email-SMS / Organic / Direct
export const PAGE_MIX: Record<string, number[]> = {
  '/': [8, 10, 10, 6, 10, 18, 38],
  '/collections/best-sellers': [32, 10, 22, 8, 6, 12, 10],
  '/products/tea-sampler': [28, 6, 24, 18, 4, 10, 10],
  '/pages/tiktok-offer': [1, 0, 6, 90, 1, 1, 1],
  '/products/gift-set': [18, 10, 16, 6, 22, 10, 18],
  '/blogs/brewing-guide': [2, 8, 6, 2, 10, 60, 12],
};

// 毛利率（用于盈亏平衡 ROAS = 1 / 毛利率）
export const GROSS_MARGIN = 0.42;
