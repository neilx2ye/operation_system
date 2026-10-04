import fs from 'node:fs';
import path from 'node:path';

import { dbOne, dbRows, storageBackend, withTx } from './pool';
import { broadcastReload } from '@/lib/hotReload';

// OPS 运营数据（非 EDM）的存储访问层。
//
// postgres 后端：写进专用表。
// file 后端：沿用旧的 data/*.json 文件，保持 smoke/edm 测试可在无数据库时运行。
// memory 后端：退化为 file（这些是单实例运营数据，测试只需读写一致）。
//
// 这里只做「读全部 / 整体替换」与少数单键操作，与旧实现的读改写语义一致。

const DATA_DIR = path.join(process.cwd(), 'data');

export function useDb(): boolean {
  return storageBackend() === 'postgres';
}

// ---------- 文件后端工具 ----------

function filePath(name: string): string {
  return path.join(DATA_DIR, name);
}

function readJsonFile<T>(name: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath(name), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJsonFile(name: string, value: unknown): void {
  const file = filePath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw e;
  }
}

// ---------- 设置（单行文档） ----------

export async function readSettingsDoc(): Promise<unknown | null> {
  if (!useDb()) return readJsonFile<unknown | null>('settings.json', null);
  const row = await dbOne<{ data: unknown }>('SELECT data FROM ops_settings WHERE id = 1');
  return row ? row.data : null;
}

export async function writeSettingsDoc(value: unknown): Promise<void> {
  if (!useDb()) {
    writeJsonFile('settings.json', value);
    broadcastReload('settings');
    return;
  }
  await dbRows(
    `INSERT INTO ops_settings (id, data) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [value],
  );
  broadcastReload('settings');
}

// ---------- 客户标签（map: customerId -> string[]） ----------

export async function readAllTags(): Promise<Record<string, string[]>> {
  if (!useDb()) return readJsonFile<Record<string, string[]>>('tags.json', {});
  const rows = await dbRows<{ customer_id: string; tags: unknown }>('SELECT customer_id, tags FROM ops_customer_tags');
  const out: Record<string, string[]> = {};
  for (const r of rows) if (Array.isArray(r.tags)) out[r.customer_id] = r.tags as string[];
  return out;
}

export async function replaceAllTags(store: Record<string, string[]>): Promise<void> {
  if (!useDb()) {
    writeJsonFile('tags.json', store);
    broadcastReload('tags');
    return;
  }
  await withTx(async (c) => {
    await c.query('DELETE FROM ops_customer_tags');
    for (const [customerId, tags] of Object.entries(store)) {
      if (!Array.isArray(tags) || tags.length === 0) continue;
      // 必须显式 JSON 序列化：node-postgres 会把 JS 数组转成 Postgres 数组字面量，无法写入 jsonb 列
      await c.query('INSERT INTO ops_customer_tags (customer_id, tags) VALUES ($1, $2::jsonb)', [customerId, JSON.stringify(tags)]);
    }
  });
  broadcastReload('tags');
}

// ---------- 客户分组（定义 + 成员） ----------

export type GroupRecord = { id: string; name: string; color: string };
export type GroupStore = { groups: GroupRecord[]; members: Record<string, string[]> };

export async function readGroups(): Promise<GroupStore> {
  if (!useDb()) {
    const s = readJsonFile<Partial<GroupStore>>('groups.json', {});
    return {
      groups: Array.isArray(s.groups) ? s.groups : [],
      members: s.members && typeof s.members === 'object' ? s.members : {},
    };
  }
  const groups = await dbRows<GroupRecord>('SELECT id, name, color FROM ops_customer_groups ORDER BY seq ASC');
  const memberRows = await dbRows<{ customer_id: string; group_id: string }>('SELECT customer_id, group_id FROM ops_customer_group_members');
  const members: Record<string, string[]> = {};
  for (const r of memberRows) (members[r.customer_id] ||= []).push(r.group_id);
  return { groups, members };
}

export async function writeGroups(store: GroupStore): Promise<void> {
  if (!useDb()) {
    writeJsonFile('groups.json', store);
    broadcastReload('groups');
    return;
  }
  await withTx(async (c) => {
    const ids = store.groups.map((g) => g.id);
    // 删除已移除的分组（成员随外键级联删除）
    if (ids.length) await c.query('DELETE FROM ops_customer_groups WHERE id <> ALL($1::text[])', [ids]);
    else await c.query('DELETE FROM ops_customer_groups');
    for (const g of store.groups) {
      await c.query(
        `INSERT INTO ops_customer_groups (id, name, color) VALUES ($1,$2,$3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, color = EXCLUDED.color`,
        [g.id, g.name, g.color],
      );
    }
    await c.query('DELETE FROM ops_customer_group_members');
    for (const [customerId, gids] of Object.entries(store.members)) {
      for (const gid of gids) {
        await c.query('INSERT INTO ops_customer_group_members (customer_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
          customerId,
          gid,
        ]);
      }
    }
  });
  broadcastReload('groups');
}

// ---------- 发货运单（map: orderId -> Shipment） ----------

export async function readShipments(): Promise<Record<string, unknown>> {
  if (!useDb()) return readJsonFile<Record<string, unknown>>('shipments.json', {});
  const rows = await dbRows<{ order_id: string; data: unknown }>('SELECT order_id, data FROM ops_shipments');
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.order_id] = r.data;
  return out;
}

export async function replaceAllShipments(store: Record<string, unknown>): Promise<void> {
  if (!useDb()) {
    writeJsonFile('shipments.json', store);
    broadcastReload('shipments');
    return;
  }
  await withTx(async (c) => {
    await c.query('DELETE FROM ops_shipments');
    for (const [orderId, data] of Object.entries(store)) {
      await c.query('INSERT INTO ops_shipments (order_id, data) VALUES ($1,$2)', [orderId, data]);
    }
  });
  broadcastReload('shipments');
}

// ---------- 商品目录覆盖（map: productId -> patch） ----------

/** 只取目录覆盖的修订号（很轻），用于判断内存缓存是否需要重建。 */
export async function readCatalogOverridesRevision(): Promise<string | null> {
  if (!useDb()) {
    try {
      return String(fs.statSync(filePath('catalog.json')).mtimeMs);
    } catch {
      return null;
    }
  }
  const row = await dbOne<{ rev: string | null }>('SELECT max(updated_at)::text AS rev FROM ops_catalog_overrides');
  return row?.rev ?? null;
}

export async function readCatalogOverrides(): Promise<{ overrides: Record<string, Record<string, unknown>>; revision: string | null }> {
  if (!useDb()) {
    try {
      const st = fs.statSync(filePath('catalog.json'));
      if (!st.isFile()) return { overrides: {}, revision: null };
      const raw = JSON.parse(fs.readFileSync(filePath('catalog.json'), 'utf8'));
      return { overrides: raw && typeof raw === 'object' ? raw : {}, revision: String(st.mtimeMs) };
    } catch {
      return { overrides: {}, revision: null };
    }
  }
  const rows = await dbRows<{ product_id: string; data: unknown }>('SELECT product_id, data FROM ops_catalog_overrides');
  const out: Record<string, Record<string, unknown>> = {};
  for (const r of rows) if (r.data && typeof r.data === 'object') out[r.product_id] = r.data as Record<string, unknown>;
  const rev = await dbOne<{ rev: string | null }>('SELECT max(updated_at)::text AS rev FROM ops_catalog_overrides');
  return { overrides: out, revision: rev?.rev ?? null };
}

export async function replaceAllCatalogOverrides(store: Record<string, Record<string, unknown>>): Promise<void> {
  if (!useDb()) {
    writeJsonFile('catalog.json', store);
    broadcastReload('catalog');
    return;
  }
  await withTx(async (c) => {
    await c.query('DELETE FROM ops_catalog_overrides');
    for (const [productId, data] of Object.entries(store)) {
      await c.query('INSERT INTO ops_catalog_overrides (product_id, data) VALUES ($1,$2)', [productId, data]);
    }
  });
  broadcastReload('catalog');
}

// ---------- Shopify 同步缓存（单行文档 + 同步时间） ----------

export type ShopifyCacheDoc = { data: unknown | null; syncedAt: string | null; revision: string | null };

/** 只取 Shopify 缓存的修订号（很轻），用于判断是否需要读取整包缓存并重建内存数据。 */
export async function readShopifyCacheRevision(): Promise<string | null> {
  if (!useDb()) {
    try {
      return String(fs.statSync(filePath('shopify-cache.json')).mtimeMs);
    } catch {
      return null;
    }
  }
  const row = await dbOne<{ rev: string | null }>('SELECT updated_at::text AS rev FROM shopify_cache WHERE id = 1');
  return row?.rev ?? null;
}

export async function readShopifyCache(): Promise<ShopifyCacheDoc> {
  if (!useDb()) {
    try {
      const st = fs.statSync(filePath('shopify-cache.json'));
      if (!st.isFile()) return { data: null, syncedAt: null, revision: null };
      const raw = JSON.parse(fs.readFileSync(filePath('shopify-cache.json'), 'utf8'));
      if (!raw || typeof raw !== 'object') return { data: null, syncedAt: null, revision: String(st.mtimeMs) };
      return { data: raw, syncedAt: typeof raw.syncedAt === 'string' ? raw.syncedAt : null, revision: String(st.mtimeMs) };
    } catch {
      return { data: null, syncedAt: null, revision: null };
    }
  }
  const row = await dbOne<{ data: unknown; synced_at: string | null; rev: string | null }>(
    'SELECT data, synced_at, updated_at::text AS rev FROM shopify_cache WHERE id = 1',
  );
  return row ? { data: row.data, syncedAt: row.synced_at, revision: row.rev } : { data: null, syncedAt: null, revision: null };
}

export async function writeShopifyCache(data: unknown, syncedAt: string | null): Promise<void> {
  if (!useDb()) {
    writeJsonFile('shopify-cache.json', data);
    broadcastReload('shopify-cache');
    return;
  }
  await dbRows(
    `INSERT INTO shopify_cache (id, data, synced_at) VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, synced_at = EXCLUDED.synced_at, updated_at = now()`,
    [data, syncedAt],
  );
  broadcastReload('shopify-cache');
}

// ---------- Shopify 同步状态（单行文档） ----------

export async function readSyncStatusDoc(): Promise<unknown | null> {
  if (!useDb()) return readJsonFile<unknown | null>('shopify-sync-status.json', null);
  const row = await dbOne<{ data: unknown }>('SELECT data FROM shopify_sync_status WHERE id = 1');
  return row ? row.data : null;
}

export async function writeSyncStatusDoc(value: unknown): Promise<void> {
  if (!useDb()) {
    writeJsonFile('shopify-sync-status.json', value);
    return;
  }
  await dbRows(
    `INSERT INTO shopify_sync_status (id, data) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [value],
  );
}
