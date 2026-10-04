// Shopify Customer tags 双向同步的服务端工具。
// customer id 使用系统缓存里的 c<Shopify numeric id>；没有 c 前缀的 mock / 无归属订单客户不会写回 Shopify。

import { shopifyConfig, type ShopifyConfig } from '@/lib/shopifyFulfill';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_TAG = 255;

// 标签读取的短期缓存：客户/用户页每次加载都会按同一批 id 读取远端标签，
// 缓存后重复切页不再打 Admin API（默认 60s，可用 SHOPIFY_TAGS_CACHE_MS 调整）。
const TAGS_TTL_MS = Number(process.env.SHOPIFY_TAGS_CACHE_MS) || 60_000;
const tagsCache = new Map<string, { at: number; data: Record<string, string[]> }>();

/** 本地写标签后调用，避免其后短时间内的读取拿到旧值。 */
export function clearShopifyTagsCache(): void {
  tagsCache.clear();
}

export type ShopifyTagSync = {
  configured: boolean;
  synced: boolean;
  reason?: string;
  applied?: number;
  failedIds?: string[];
};

function gid(id: string) {
  const m = /^c(\d+)$/.exec(id);
  return m ? `gid://shopify/Customer/${m[1]}` : null;
}

async function gql(cfg: ShopifyConfig, query: string, variables: Record<string, unknown>) {
  const res = await fetch(`https://${cfg.shop}/admin/api/${cfg.version}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': cfg.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30000),
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json) throw new Error('Shopify HTTP ' + res.status);
  if (json.errors?.length) throw new Error('Shopify GraphQL: ' + JSON.stringify(json.errors).slice(0, 500));
  return json.data;
}

/** 查询客户现有 Shopify tags，供本地标签 API 合并使用。
 *  opts.fresh=true 时绕过缓存（POST 写回前需要最新值）。 */
export async function fetchShopifyCustomerTags(ids: string[], opts: { fresh?: boolean } = {}): Promise<Record<string, string[]>> {
  const cacheKey = [...ids].sort().join(',');
  const hit = tagsCache.get(cacheKey);
  if (!opts.fresh && hit && Date.now() - hit.at < TAGS_TTL_MS) return hit.data;

  const cfg = await shopifyConfig();
  if (!cfg) return {};
  const pairs = ids.map((id) => [id, gid(id)] as const).filter((x): x is readonly [string, string] => !!x[1]);
  const out: Record<string, string[]> = {};
  // nodes 支持最多 250 个 ID；这里的调用一般远低于该数，仍做分片以免未来批量操作超限。
  for (let i = 0; i < pairs.length; i += 200) {
    const chunk = pairs.slice(i, i + 200);
    const data = await gql(
      cfg,
      `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Customer { id tags } } }`,
      { ids: chunk.map((x) => x[1]) },
    );
    (data.nodes || []).forEach((node: any, n: number) => {
      if (node?.id) out[chunk[n][0]] = Array.isArray(node.tags) ? node.tags.map(String) : [];
    });
  }
  tagsCache.set(cacheKey, { at: Date.now(), data: out });
  return out;
}

/**
 * 把「期望的完整标签集合」写入 Shopify。
 * tagsAdd / tagsRemove 支持批量对象；这里逐客户执行是为了让本地 store 和远端精确收敛，并返回失败的客户。
 */
export async function syncCustomerTagsToShopify(nextById: Record<string, string[]>): Promise<ShopifyTagSync> {
  const cfg = await shopifyConfig();
  if (!cfg) return { configured: false, synced: false, reason: 'Shopify 未配置，标签只保存到本地' };
  const entries = Object.entries(nextById)
    .map(([id, tags]) => ({ id, gid: gid(id), tags: [...new Set(tags.map((x) => x.trim()).filter(Boolean))].slice(0, 250).map((x) => x.slice(0, MAX_TAG)) }))
    .filter((x): x is { id: string; gid: string; tags: string[] } => !!x.gid);
  if (!entries.length) return { configured: true, synced: true, applied: 0 };

  const failedIds: string[] = [];
  for (const item of entries) {
    try {
      // 完整替换能同时处理 add / remove；使用 customerUpdate 的 tags 字段。
      const data = await gql(
        cfg,
        `mutation($input: CustomerInput!) { customerUpdate(input: $input) { customer { id tags } userErrors { field message } } }`,
        { input: { id: item.gid, tags: item.tags } },
      );
      const errors = data.customerUpdate?.userErrors || [];
      if (errors.length) throw new Error(errors.map((e: any) => e.message).join('; '));
    } catch {
      failedIds.push(item.id);
    }
    // 温和控制 Admin GraphQL 调用节奏，避免大批量操作瞬间耗尽 cost budget。
    if (entries.length > 1) await sleep(35);
  }
  return {
    configured: true,
    synced: failedIds.length === 0,
    applied: entries.length - failedIds.length,
    failedIds: failedIds.length ? failedIds : undefined,
    reason: failedIds.length ? `${failedIds.length} 位用户同步到 Shopify 失败` : undefined,
  };
}
