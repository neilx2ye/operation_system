import { allCustomerRows, dataSourceInfo, type CustomerRow } from '@/lib/mock';
import { sha256 } from '@/lib/edm/ids';

// 只读客户来源适配层：给 EDM 受众计算提供「来源 / 店铺 / 版本 / 邮箱可用性」。
// 不引入旧 EDM 用户表，也不改写 mock.ts 与 shopifySync.ts 的分析算法。

export type DataSource = 'mock' | 'shopify';

export type EmailStatus = 'valid' | 'placeholder' | 'empty' | 'invalid';

export type SourcedCustomer = CustomerRow & {
  /** 与 CustomerRow.source（获客渠道）不同：这里区分 Mock 与真实数据源 */
  dataSource: DataSource;
  emailStatus: EmailStatus;
  /** 规范化后的邮箱，仅服务端使用，不返回给浏览器 */
  emailKey: string | null;
  /** OPS 本地标识来源：c… 来自 Shopify 客户，g… 是访客/合成标识 */
  role: 'customer' | 'guest';
};

export type SourceRevision = {
  dataSource: DataSource;
  storeKey: string;
  /** 内容指纹，不依赖「Shopify」这个名字；数据变化时快照立即失效 */
  revision: string;
  syncedAt: string | null;
};

const PLACEHOLDER_EMAILS = new Set(['(无邮箱)', '(no email)', 'n/a', '-', 'null', 'undefined', 'unknown']);
const EMAIL_RE = /^[^\s@,;<>()[\]\\]+@[^\s@,;<>()[\]\\]+\.[A-Za-z]{2,}$/;

/** 规范化：去首尾空白 + 小写。不做 Gmail 去点/去加号合并。 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return null;
  if (PLACEHOLDER_EMAILS.has(v)) return null;
  return v;
}

export function emailStatusOf(raw: string | null | undefined): EmailStatus {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return 'empty';
  if (PLACEHOLDER_EMAILS.has(trimmed.toLowerCase())) return 'placeholder';
  const norm = normalizeEmail(trimmed);
  if (!norm || !EMAIL_RE.test(norm)) return 'invalid';
  return 'valid';
}

let revisionCache: { key: string; revision: string } | null = null;

export async function currentSource(): Promise<SourceRevision> {
  const info = await dataSourceInfo();
  const dataSource = info.source as DataSource;
  const storeKey = dataSource === 'mock' ? 'mock' : (info.shop ?? 'shopify-unknown');
  const key = [dataSource, info.syncedAt ?? '', info.counts.customers, info.counts.orders, storeKey].join('|');
  if (revisionCache?.key === key) return { dataSource, storeKey, revision: revisionCache.revision, syncedAt: info.syncedAt };
  // 指纹覆盖实际内容：仅同步时间变化而内容不变时，不需要让快照失效
  const digest = sha256(
    (await allCustomerRows())
      .map((r) => `${r.id}:${r.orders}:${r.ltv}:${r.email}`)
      .sort()
      .join('\n'),
  );
  const revision = sha256(`${key}|${digest}`).slice(0, 32);
  revisionCache = { key, revision };
  return { dataSource, storeKey, revision, syncedAt: info.syncedAt };
}

export async function listCustomers(): Promise<SourcedCustomer[]> {
  const { dataSource } = await currentSource();
  return (await allCustomerRows()).map((r) => decorate(r, dataSource));
}

export async function customerById(id: string): Promise<SourcedCustomer | null> {
  const row = (await allCustomerRows()).find((r) => r.id === id);
  if (!row) return null;
  return decorate(row, (await currentSource()).dataSource);
}

/** 按 id 批量取，保持输入顺序，找不到的返回 null */
export async function customersByIds(ids: string[]): Promise<(SourcedCustomer | null)[]> {
  const { dataSource } = await currentSource();
  const map = new Map((await allCustomerRows()).map((r) => [r.id, r]));
  return ids.map((id) => {
    const row = map.get(id);
    return row ? decorate(row, dataSource) : null;
  });
}

function decorate(r: CustomerRow, dataSource: DataSource): SourcedCustomer {
  const status = emailStatusOf(r.email);
  return {
    ...r,
    dataSource,
    emailStatus: status,
    emailKey: status === 'valid' ? normalizeEmail(r.email) : null,
    role: r.id.startsWith('g') ? 'guest' : 'customer',
  };
}