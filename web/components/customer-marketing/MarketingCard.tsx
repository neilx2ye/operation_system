'use client';

import type { KlaviyoMarketingStatus } from '@/lib/edm/types';
import { MarketingStatusTag, formatDateTime } from './MarketingStatusTag';
import styles from './customerMarketing.module.css';

function YesNo({ value, yes, no }: { value: boolean | null | undefined; yes: string; no: string }) {
  if (value === true) return <span className={styles.valYes}>{yes}</span>;
  if (value === false) return <span className={styles.valNo}>{no}</span>;
  return <span className={styles.valUnknown}>未知</span>;
}

/**
 * 详情侧栏的 Klaviyo 营销卡片。
 * 这里刻意把「订阅同意」「抑制」「名单成员」分成三组展示：
 * 它们不是同一个概念，加入名单或创建资料都不代表用户同意营销。
 */
export function MarketingCard({
  status,
  profileId = null,
  listNames = [],
}: {
  status?: KlaviyoMarketingStatus | null;
  /** 已建立的 Klaviyo Profile 映射；本地没有映射时传 null，显示未匹配 */
  profileId?: string | null;
  /** 已知的名单归属；没有可靠来源时不要猜测 */
  listNames?: string[];
}) {
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <b>Klaviyo 营销状态</b>
        <MarketingStatusTag status={status} />
      </div>

      <div className={styles.kvRows}>
        <div className={styles.kvRow}>
          <span className={styles.kvKey}>Profile ID</span>
          <span className={styles.kvVal}>{profileId ? <code className={styles.mono}>{profileId}</code> : '未匹配'}</span>
        </div>

        <div className={styles.kvRow}>
          <span className={styles.kvKey}>订阅同意</span>
          <span className={styles.kvVal}>
            <YesNo value={status?.subscribed} yes="已订阅" no="未订阅" />
          </span>
        </div>

        <div className={styles.kvRow}>
          <span className={styles.kvKey}>能否接收邮件</span>
          <span className={styles.kvVal}>
            <YesNo value={status?.canReceiveEmail} yes="能" no="不能" />
          </span>
        </div>

        <div className={styles.kvRow}>
          <span className={styles.kvKey}>全局抑制</span>
          <span className={styles.kvVal}>
            <YesNo value={status?.globalSuppressed} yes="已抑制" no="未抑制" />
          </span>
        </div>

        <div className={styles.kvRow}>
          <span className={styles.kvKey}>目标名单抑制</span>
          <span className={styles.kvVal}>
            <YesNo value={status?.listSuppressed} yes="已抑制" no="未抑制" />
          </span>
        </div>

        <div className={styles.kvRow}>
          <span className={styles.kvKey}>所属名单</span>
          <span className={styles.kvVal}>{listNames.length ? listNames.join('、') : '未知'}</span>
        </div>

        <div className={styles.kvRow}>
          <span className={styles.kvKey}>查询时间</span>
          <span className={styles.kvVal}>{status ? formatDateTime(status.checkedAt) : '未知'}</span>
        </div>
      </div>

      <div className={styles.cardNote}>
        订阅同意、抑制、名单成员是三个独立概念：创建资料或加入名单都不代表用户已同意营销，OPS 也不会自动订阅或取消抑制。
        任一状态为「未知」时默认排除，不进入营销名单同步。
      </div>
    </div>
  );
}