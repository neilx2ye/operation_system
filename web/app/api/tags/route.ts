import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { fetchShopifyCustomerTags, syncCustomerTagsToShopify } from '@/lib/shopifyCustomerTags';

export const dynamic = 'force-dynamic';

// 客户标签存储：{ [customerId]: string[] }，落盘到 web/data/tags.json。
// 后续接 Postgres/Supabase 时，只需替换 load/save 两个函数。
const FILE = path.join(process.cwd(), 'data', 'tags.json');
type Store = Record<string, string[]>;

async function load(): Promise<Store> {
  try {
    return JSON.parse(await fs.readFile(FILE, 'utf8')) as Store;
  } catch {
    return {};
  }
}

async function save(store: Store) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
  await fs.rename(tmp, FILE);
}

const clean = (a: unknown): string[] =>
  Array.isArray(a) ? [...new Set(a.map((x) => String(x).trim().slice(0, 30)).filter(Boolean))] : [];

/** 本地操作标签与 Shopify 已有标签合并。这里的 store 是本地副本 / 离线降级缓存。 */
function merge(base: Store, remote: Store): Store {
  const out: Store = { ...base };
  for (const [id, tags] of Object.entries(remote)) {
    const next = [...new Set([...(base[id] || []), ...tags])];
    if (next.length) out[id] = next;
  }
  return out;
}

export async function GET(req: Request) {
  const ids = new URL(req.url).searchParams
    .get('ids')
    ?.split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const local = await load();
  if (!ids?.length) return NextResponse.json(local);
  try {
    const remote = await fetchShopifyCustomerTags(ids);
    const merged = merge(local, remote);
    // 读取到的 Shopify 标签也写入本地缓存，供离线 / Mock 模式展示。
    if (JSON.stringify(merged) !== JSON.stringify(local)) await save(merged);
    return NextResponse.json(merged);
  } catch {
    return NextResponse.json(local, { headers: { 'X-Tag-Sync': 'shopify-read-failed' } });
  }
}

// body: { ids: string[], add?: string[], remove?: string[] }
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.ids)) {
    return NextResponse.json({ error: 'ids required' }, { status: 400 });
  }
  const ids: string[] = [...new Set((body.ids as unknown[]).map((id) => String(id)))];
  const add = clean(body.add);
  const remove = new Set(clean(body.remove));
  const store = await load();

  // 优先读 Shopify 当前标签再计算，避免后台刚加的标签被本系统的过期本地副本覆盖。
  let remote: Store = {};
  try {
    remote = await fetchShopifyCustomerTags(ids);
  } catch {
    // 无配置 / 瞬态读取失败时以本地缓存继续，写回结果会在 sync 状态中明确告知。
  }
  const merged = merge(store, remote);
  const desired: Store = {};
  for (const id of ids) {
    const next = [...new Set([...(merged[id] || []), ...add])].filter((t) => !remove.has(t));
    desired[id] = next;
    if (next.length) merged[id] = next;
    else delete merged[id];
  }

  // 先写远端；任一远端客户失败时不落盘那些失败客户，防止 UI 声称已同步。
  const sync = await syncCustomerTagsToShopify(desired);
  const failed = new Set(sync.failedIds || []);
  for (const id of failed) {
    if (store[id]?.length) merged[id] = store[id];
    else delete merged[id];
  }
  await save(merged);
  return NextResponse.json(merged, {
    status: failed.size ? 207 : 200,
    headers: {
      'X-Tag-Sync': sync.synced ? 'shopify-ok' : sync.configured ? 'shopify-partial-failed' : 'local-only',
      ...(sync.reason ? { 'X-Tag-Sync-Message': encodeURIComponent(sync.reason) } : {}),
    },
  });
}
