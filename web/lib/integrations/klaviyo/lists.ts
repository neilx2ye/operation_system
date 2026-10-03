import { klaviyoFetch, klaviyoListAll } from './client';
import { klaviyoConfig, type KlaviyoConfig } from './config';
import type { KlaviyoListRecord } from '@/lib/edm/types';

// 名单：读取与「只增加成员」。
// 明确不做全量覆盖，也不做删除远端多余成员。

type ListAttributes = { name?: string | null; created?: string | null; updated?: string | null; profile_count?: number | null };

export async function fetchLists(cfg: KlaviyoConfig | null = klaviyoConfig()): Promise<KlaviyoListRecord[]> {
  // 官方对 GET /api/lists 的 page[size] 上限为 10
  const rows = await klaviyoListAll<ListAttributes>('/api/lists', { 'page[size]': 10 }, (body) => body.data ?? [], { cfg, label: '名单' });
  const fetchedAt = new Date().toISOString();
  return rows.map((r) => ({
    id: r.id,
    name: r.attributes?.name || r.id,
    profileCount: typeof r.attributes?.profile_count === 'number' ? r.attributes.profile_count : null,
    fetchedAt,
  }));
}

/** Klaviyo 单次最多 1000 条；OPS 用更小的批次，避免刺激限流 */
export const LIST_BATCH_SIZE = 100;

/**
 * 读取名单当前成员 ID。
 * 用于恢复写入时的应用级去重：只提交确实还不是成员的 profile，
 * 不假定 Klaviyo 的「加入名单」接口本身幂等。
 * 名单很大时不做全量枚举，交由人工核对。
 */
export async function fetchListMemberIds(listId: string, cfg: KlaviyoConfig | null = klaviyoConfig(), maxPages = 5): Promise<{ ids: Set<string>; complete: boolean }> {
  const ids = new Set<string>();
  let next: string | null = `/api/lists/${encodeURIComponent(listId)}/relationships/profiles?page[size]=100`;
  for (let page = 0; page < maxPages && next; page++) {
    const body: { data?: { id: string }[]; links?: { next?: string | null } } = await klaviyoFetch(
      { path: next },
      cfg,
    );
    for (const r of body?.data ?? []) ids.add(r.id);
    next = body?.links?.next ?? null;
  }
  return { ids, complete: next === null };
}

export type BatchProgress = { batch: number; sent: number; total: number };

export type AddResult = { sent: number; batches: number; remaining: string[] };

/**
 * 分批把 profile 加入名单。每批之间间隔一段时间，
 * 并把进度回调出去，让执行记录能逐批写入。
 * 单批失败会向上抛出，由调用方区分「已成功部分」与「结果不明」。
 */
export async function addProfilesToList(
  listId: string,
  profileIds: string[],
  opts: { cfg?: KlaviyoConfig | null; batchSize?: number; delayMs?: number; onBatch?: (p: BatchProgress) => void; maxBatches?: number; deadline?: number } = {},
): Promise<AddResult> {
  const cfg = opts.cfg ?? klaviyoConfig();
  const batchSize = Math.min(opts.batchSize ?? LIST_BATCH_SIZE, 1000);
  const delayMs = opts.delayMs ?? 250;
  const maxBatches = opts.maxBatches ?? Number.POSITIVE_INFINITY;
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;

  let sent = 0;
  let batches = 0;
  for (let i = 0; i < profileIds.length; i += batchSize) {
    if (batches >= maxBatches || Date.now() > deadline) {
      return { sent, batches, remaining: profileIds.slice(i) };
    }
    const chunk = profileIds.slice(i, i + batchSize);
    await klaviyoFetch(
      {
        method: 'POST',
        path: `/api/lists/${encodeURIComponent(listId)}/relationships/profiles`,
        body: { data: chunk.map((id) => ({ type: 'profile', id })) },
        // 名单写入不是幂等操作，超时结果不明，不自动重发
        idempotent: false,
      },
      cfg,
    );
    sent += chunk.length;
    batches++;
    opts.onBatch?.({ batch: batches, sent, total: profileIds.length });
    if (i + batchSize < profileIds.length) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { sent, batches, remaining: [] };
}