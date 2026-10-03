'use client';

import type { KlaviyoMarketingStatus } from '@/lib/edm/types';
import styles from './customerMarketing.module.css';

// 订阅同意、能否接收邮件、抑制是三件独立的事：
// 只有「明确已订阅 + 能接收邮件 + 未被全局/名单抑制」才显示「已订阅」，
// 其余组合一律按未确认处理（未知状态默认排除，不进入名单同步）。

export type MarketingTagKind = 'subscribed' | 'unsubscribed' | 'suppressed' | 'unknown';

export function marketingTagKind(s: KlaviyoMarketingStatus | null | undefined): MarketingTagKind {
  if (!s) return 'unknown';
  if (s.globalSuppressed === true || s.listSuppressed === true) return 'suppressed';
  if (s.subscribed === false) return 'unsubscribed';
  if (s.subscribed === true && s.canReceiveEmail === true && s.globalSuppressed === false && s.listSuppressed === false) return 'subscribed';
  return 'unknown';
}

export const MARKETING_TAG_LABELS: Record<MarketingTagKind, string> = {
  subscribed: '已订阅',
  unsubscribed: '未订阅',
  suppressed: '已抑制',
  unknown: '未知',
};

const TAG_CLASS: Record<MarketingTagKind, string> = {
  subscribed: styles.tagSubscribed,
  unsubscribed: styles.tagUnsubscribed,
  suppressed: styles.tagSuppressed,
  unknown: styles.tagUnknown,
};

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 已知记录的营销状态标签：已订阅 / 未订阅 / 已抑制 / 未知 */
export function MarketingStatusTag({ status }: { status: KlaviyoMarketingStatus | null | undefined }) {
  const kind = marketingTagKind(status);
  const title = status ? `查询时间：${formatDateTime(status.checkedAt)}` : '本地没有查询记录';
  return (
    <span className={`${styles.tag} ${TAG_CLASS[kind]}`} title={title}>
      {MARKETING_TAG_LABELS[kind]}
    </span>
  );
}

/** 本地缓存里没有记录时使用：显示「未查询」，而不是给出可能误导的营销结论 */
export function MarketingStatusMissing() {
  return (
    <span className={`${styles.tag} ${styles.tagMissing}`} title="本地还没有该客户的查询记录；请先点击「刷新营销状态」">
      未查询
    </span>
  );
}