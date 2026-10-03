import type { CustomerRow } from '@/lib/mock';

// 从 CustomerInsights 抽出的纯筛选/分群规则。
// 服务端计算受众时必须与页面完全一致，因此这里不放任何 React 或浏览器依赖。

export const SEGMENTS = [
  { key: '高价值忠诚', color: '#16a34a', action: '新品优先、会员权益、邀请评价/转介绍' },
  { key: '复购活跃', color: '#4ade80', action: '补货提醒、搭配推荐、提升客单价' },
  { key: '新客(30天内)', color: '#3b82f6', action: '欢迎流程、使用指南、7-14 天二购提醒' },
  { key: '弃购未成交', color: '#f97316', action: '弃购挽回邮件(1h/24h/72h)、小额首单券、高客单人工跟进' },
  { key: '待二购', color: '#f59e0b', action: '关联产品/二购券邮件，抓住复购窗口' },
  { key: '重点召回', color: '#ef4444', action: '老客召回、专属优惠、人工关怀' },
  { key: '沉睡单购', color: '#94a3b8', action: '低成本邮件/再营销，不加大投入' },
  { key: '全退款', color: '#7c3aed', action: '排查退款原因（产品/物流/预期），暂不促销' },
] as const;

export type SegmentKey = (typeof SEGMENTS)[number]['key'];

export type Filters = { segment?: string; source?: string; country?: string; cohort?: string; abandon?: string };
export type FilterKey = keyof Filters;
export const FILTER_LABELS: Record<FilterKey, string> = { segment: '分层', source: '渠道', country: '国家', cohort: '首购月', abandon: '弃购' };

/** 标签筛选里表示「未打标签」的哨兵值 */
export const TAG_NONE = '__none__';

export function cohortOf(r: CustomerRow): string | null {
  return r.firstOrder ? (r.firstOrder as string).slice(0, 7) : null;
}

export function matchFilters(r: CustomerRow, f: Filters): boolean {
  if (f.segment && segmentOf(r) !== f.segment) return false;
  if (f.source && r.source !== f.source) return false;
  if (f.country && r.country !== f.country) return false;
  if (f.cohort && cohortOf(r) !== f.cohort) return false;
  if (f.abandon && !(r.abandons > 0)) return false;
  return true;
}

/** 规则分群：R=距今天数，F=订单数，M=净 LTV。阈值可按业务调整。 */
export function segmentOf(r: CustomerRow): SegmentKey {
  const d = r.daysSince ?? 9999;
  if (r.orders === 0) return '弃购未成交';
  if (r.ltv <= 0) return '全退款';
  if (r.orders >= 2) {
    if (d > 90) return '重点召回';
    if ((r.orders >= 3 || r.ltv >= 100) && d <= 60) return '高价值忠诚';
    return '复购活跃';
  }
  if (d <= 30) return '新客(30天内)';
  if (d <= 90) return '待二购';
  return '沉睡单购';
}

/**
 * 关键字搜索的字段集合。必须与 CustomersView 里展示的列保持一致，
 * 否则服务端与页面会给出不同的人数。
 */
export function customerSearchText(r: CustomerRow, tags: string[] = []): string {
  return [
    r.email,
    r.country,
    r.source,
    segmentOf(r),
    r.orders,
    r.ltv,
    r.refunds,
    r.firstOrder,
    r.lastOrder,
    r.daysSince,
    r.abandons,
    r.abandonValue,
    r.lastAbandon,
    tags.join(' '),
  ]
    .filter((v) => v !== null && v !== undefined)
    .join(' ')
    .toLowerCase();
}

export type FilterOptions = {
  /** 标签筛选：TAG_NONE 表示只保留未打标签的客户 */
  tag?: string | null;
  tagOf?: (id: string) => string[];
  /** 自由搜索。可能含邮箱，因此调用方不得把它写进 URL 或日志。 */
  query?: string;
};

/** 前后端共用的筛选实现：页面与 /api/edm/audiences 都调用这一个函数 */
export function filterCustomers<T extends CustomerRow>(rows: T[], filters: Filters, opts: FilterOptions = {}): T[] {
  const tagOf = opts.tagOf ?? (() => []);
  const tag = opts.tag ?? null;
  const q = (opts.query ?? '').trim().toLowerCase();
  return rows.filter((r) => {
    if (!matchFilters(r, filters)) return false;
    const tags = tagOf(r.id);
    if (tag === TAG_NONE) {
      if (tags.length) return false;
    } else if (tag) {
      if (!tags.includes(tag)) return false;
    }
    if (q && !customerSearchText(r, tags).includes(q)) return false;
    return true;
  });
}

/** 筛选条件的可读摘要，用于页面确认「作用范围」 */
export function describeFilters(f: Filters, tag?: string | null): string[] {
  const out: string[] = [];
  (Object.keys(FILTER_LABELS) as FilterKey[]).forEach((k) => {
    if (f[k]) out.push(`${FILTER_LABELS[k]}=${f[k]}`);
  });
  if (tag === TAG_NONE) out.push('标签=未打标签');
  else if (tag) out.push(`标签=${tag}`);
  return out;
}