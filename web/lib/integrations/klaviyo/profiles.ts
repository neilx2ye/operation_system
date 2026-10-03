import { klaviyoFetch, klaviyoListAll, type KlaviyoPage } from './client';
import { klaviyoConfig, type KlaviyoConfig } from './config';
import type { KlaviyoMarketingStatus } from '@/lib/edm/types';

// Profile 读取与写入。
//
// 关键事实（按 2026-07-15 revision 核对）：
//  - 批量按邮箱查找用 filter=any(email,["a","b"])，page[size] 上限 100。
//  - 订阅数据必须显式请求 additional-fields[profile]=subscriptions。
//  - consent 与抑制是互相独立的两件事：取消订阅不会把 consent 改成 UNSUBSCRIBED，
//    而是把 can_receive_email_marketing 置为 false 并追加 suppression[] 条目。
//  - suppression / list_suppressions 是对象数组，不是布尔值。
//  - POST /api/profile-import 只能 upsert 单个 profile，不能顺便加名单。

export const PROFILE_LOOKUP_CHUNK = 50;

export type RemoteProfile = {
  id: string;
  email: string | null;
  status: KlaviyoMarketingStatus | null;
};

type ProfileAttributes = {
  email?: string | null;
  subscriptions?: {
    email?: {
      marketing?: Record<string, unknown> | null;
    } | null;
  } | null;
};

/** 从 attributes 里提取订阅/抑制状态，保留原始 consent 字符串 */
export function extractMarketingStatus(attributes: ProfileAttributes | undefined, checkedAt: string): KlaviyoMarketingStatus {
  const m = attributes?.subscriptions?.email?.marketing ?? null;
  if (!m || typeof m !== 'object') {
    return {
      canReceiveEmail: null,
      subscribed: null,
      consent: null,
      globalSuppressed: null,
      listSuppressed: null,
      suppressionReasons: [],
      listSuppressionIds: [],
      checkedAt,
    };
  }
  const raw = m as Record<string, unknown>;
  const asArray = (v: unknown): Record<string, unknown>[] | null => (Array.isArray(v) ? (v as Record<string, unknown>[]) : null);
  const suppression = asArray(raw.suppression);
  const listSuppression = asArray(raw.list_suppressions);
  const consent = typeof raw.consent === 'string' ? raw.consent : null;
  return {
    canReceiveEmail: typeof raw.can_receive_email_marketing === 'boolean' ? raw.can_receive_email_marketing : null,
    // 官方未给 read 侧 consent 枚举，只认明确的两个值，其余一律视为未知
    subscribed: consent === null ? null : consent === 'SUBSCRIBED' ? true : consent === 'UNSUBSCRIBED' ? false : null,
    consent,
    // 订阅对象存在即代表 Klaviyo 给出了状态；抑制数组是事件列表，缺省表示没有该类抑制。
    // 只有整个 subscriptions 对象缺失时才是真正的未知。
    globalSuppressed: suppression === null ? false : suppression.length > 0,
    listSuppressed: listSuppression === null ? false : listSuppression.length > 0,
    suppressionReasons: (suppression ?? []).map((s) => String(s?.reason ?? '')).filter(Boolean),
    listSuppressionIds: (listSuppression ?? []).map((s) => String(s?.list_id ?? '')).filter(Boolean),
    checkedAt,
  };
}

/** 单次请求最多 100 条 profile；这里按更小的块拆分，避免 URL 过长 */
export async function lookupProfilesByEmail(emails: string[], cfg: KlaviyoConfig | null = klaviyoConfig()): Promise<RemoteProfile[]> {
  const unique = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const checkedAt = new Date().toISOString();
  const out: RemoteProfile[] = [];

  for (let i = 0; i < unique.length; i += PROFILE_LOOKUP_CHUNK) {
    const chunk = unique.slice(i, i + PROFILE_LOOKUP_CHUNK);
    const rows = await klaviyoListAll<ProfileAttributes>(
      '/api/profiles',
      {
        filter: `any(email,[${chunk.map((e) => JSON.stringify(e)).join(',')}])`,
        'additional-fields[profile]': 'subscriptions',
        'page[size]': 100,
      },
      (body: KlaviyoPage<ProfileAttributes>) => body.data ?? [],
      { cfg, label: 'Profile' },
    );
    for (const r of rows) {
      out.push({
        id: r.id,
        email: typeof r.attributes?.email === 'string' ? r.attributes.email.toLowerCase() : null,
        status: extractMarketingStatus(r.attributes, checkedAt),
      });
    }
  }
  return out;
}

export type UpsertResult = { profileId: string; status: KlaviyoMarketingStatus };

/**
 * 创建或更新单个 profile。这是局部更新：未出现的字段保持远端原值，
 * 因此调用方只传白名单字段，绝不传 null 去清空远端。
 * 官方以 200/201 区分更新与新建，但请求器不回传状态码，
 * 因此这里只回报 profileId，不在 UI 上把「更新」说成「新建」。
 */
export async function upsertProfile(
  input: { email: string; properties: Record<string, unknown> },
  cfg: KlaviyoConfig | null = klaviyoConfig(),
): Promise<UpsertResult> {
  const attributes: Record<string, unknown> = { email: input.email };
  if (Object.keys(input.properties).length) attributes.properties = input.properties;
  const body = await klaviyoFetch<{ data?: { id?: string; attributes?: ProfileAttributes } }>(
    {
      method: 'POST',
      path: '/api/profile-import',
      // 顺便取回订阅状态，避免写入后把已知状态抹成未知
      query: { 'additional-fields[profile]': 'subscriptions' },
      body: { data: { type: 'profile', attributes } },
      // 写入不是幂等操作：超时结果不明时不自动重发
      idempotent: false,
    },
    cfg,
  );
  const id = body?.data?.id;
  if (!id) throw new Error('Klaviyo 未返回 profile id');
  return { profileId: id, status: extractMarketingStatus(body?.data?.attributes, new Date().toISOString()) };
}