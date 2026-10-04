#!/usr/bin/env node
// 把旧的 JSON 文件数据一次性导入 PostgreSQL（幂等，可重复执行）。
//
//   node scripts/migrate-data-to-db.mjs
//
// 连接串取 DATABASE_URL；缺失时回退到标准 PG* 环境变量。
// 结构由 lib/db/schema.sql 建立。导入范围：
//   data/edm/**                -> edm_* 表
//   data/settings.json         -> ops_settings
//   data/tags.json             -> ops_customer_tags
//   data/groups.json           -> ops_customer_groups / ops_customer_group_members
//   data/shipments.json        -> ops_shipments
//   data/catalog.json          -> ops_catalog_overrides
//   data/shopify-cache.json    -> shopify_cache
//   data/shopify-sync-status.json -> shopify_sync_status

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const DATA = path.join(WEB, 'data');
const EDM = path.join(DATA, 'edm');

const url = process.env.DATABASE_URL?.trim();
const pool = new pg.Pool(url ? { connectionString: url } : {});

const stats = {};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listJsonIds(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.json') && !n.includes('.tmp-') && !n.includes('.corrupt-'))
      .map((n) => n.slice(0, -'.json'.length));
  } catch {
    return [];
  }
}

function bump(k, n = 1) {
  stats[k] = (stats[k] || 0) + n;
}

async function applySchema() {
  const sql = fs.readFileSync(path.join(WEB, 'lib', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

async function importEdm(client) {
  const dirs = ['templates', 'versions', 'assets', 'audiences', 'preparations', 'operations'];
  for (const kind of dirs) {
    for (const id of listJsonIds(path.join(EDM, kind))) {
      const rec = readJson(path.join(EDM, kind, `${id}.json`));
      if (!rec || typeof rec !== 'object') continue;
      if (kind === 'templates') {
        await client.query(
          `INSERT INTO edm_templates (id, current_version_id, updated_at, created_at, data)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (id) DO UPDATE SET current_version_id=EXCLUDED.current_version_id, updated_at=EXCLUDED.updated_at, created_at=EXCLUDED.created_at, data=EXCLUDED.data`,
          [rec.id, rec.currentVersionId ?? null, rec.updatedAt ?? null, rec.createdAt ?? null, rec],
        );
      } else if (kind === 'versions') {
        await client.query(
          `INSERT INTO edm_template_versions (id, template_id, created_at, data)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (id) DO UPDATE SET template_id=EXCLUDED.template_id, created_at=EXCLUDED.created_at, data=EXCLUDED.data`,
          [rec.id, rec.templateId ?? null, rec.createdAt ?? null, rec],
        );
      } else if (kind === 'assets') {
        let body = null;
        try {
          body = fs.readFileSync(path.join(EDM, 'assets', `${id}.bin`));
        } catch {
          /* 无原图 */
        }
        await client.query(
          `INSERT INTO edm_assets (id, created_at, data, body)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (id) DO UPDATE SET created_at=EXCLUDED.created_at, data=EXCLUDED.data, body=COALESCE(EXCLUDED.body, edm_assets.body)`,
          [rec.id, rec.createdAt ?? null, rec, body],
        );
      } else if (kind === 'audiences') {
        await client.query(
          `INSERT INTO edm_audiences (id, created_at, expires_at, data)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (id) DO UPDATE SET created_at=EXCLUDED.created_at, expires_at=EXCLUDED.expires_at, data=EXCLUDED.data`,
          [rec.id, rec.createdAt ?? null, rec.expiresAt ?? null, rec],
        );
      } else if (kind === 'preparations') {
        await client.query(
          `INSERT INTO edm_preparations (id, updated_at, data)
           VALUES ($1,$2,$3)
           ON CONFLICT (id) DO UPDATE SET updated_at=EXCLUDED.updated_at, data=EXCLUDED.data`,
          [rec.id, rec.updatedAt ?? null, rec],
        );
      } else {
        await client.query(
          `INSERT INTO edm_operations (id, created_at, data)
           VALUES ($1,$2,$3)
           ON CONFLICT (id) DO UPDATE SET created_at=EXCLUDED.created_at, data=EXCLUDED.data`,
          [rec.id, rec.createdAt ?? null, rec],
        );
      }
      bump(`edm.${kind}`);
    }
  }

  // 分类索引
  const index = readJson(path.join(EDM, 'index.json'));
  if (index && Array.isArray(index.categories)) {
    for (const c of index.categories) {
      await client.query(
        `INSERT INTO edm_template_categories (id, data) VALUES ($1,$2)
         ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`,
        [c.id, c],
      );
      bump('edm.categories');
    }
  }

  // Klaviyo 集成文档
  const integ = readJson(path.join(EDM, 'integrations.json'));
  if (integ && typeof integ === 'object') {
    await client.query(
      `INSERT INTO edm_integrations (id, data) VALUES (1,$1)
       ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`,
      [integ],
    );
    bump('edm.integrations');
  }
}

async function importOps(client) {
  const settings = readJson(path.join(DATA, 'settings.json'));
  if (settings) {
    await client.query(
      `INSERT INTO ops_settings (id, data) VALUES (1,$1) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`,
      [settings],
    );
    bump('settings');
  }

  const tags = readJson(path.join(DATA, 'tags.json'));
  if (tags && typeof tags === 'object') {
    for (const [customerId, list] of Object.entries(tags)) {
      if (!Array.isArray(list) || !list.length) continue;
      await client.query(
        `INSERT INTO ops_customer_tags (customer_id, tags) VALUES ($1,$2::jsonb)
         ON CONFLICT (customer_id) DO UPDATE SET tags=EXCLUDED.tags, updated_at=now()`,
        [customerId, JSON.stringify(list)],
      );
      bump('tags');
    }
  }

  const groups = readJson(path.join(DATA, 'groups.json'));
  if (groups && Array.isArray(groups.groups)) {
    for (const g of groups.groups) {
      await client.query(
        `INSERT INTO ops_customer_groups (id, name, color) VALUES ($1,$2,$3)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, color=EXCLUDED.color`,
        [g.id, g.name ?? '', g.color ?? ''],
      );
      bump('groups');
    }
    for (const [customerId, gids] of Object.entries(groups.members || {})) {
      for (const gid of gids || []) {
        await client.query(
          `INSERT INTO ops_customer_group_members (customer_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [customerId, gid],
        );
        bump('groupMembers');
      }
    }
  }

  const shipments = readJson(path.join(DATA, 'shipments.json'));
  if (shipments && typeof shipments === 'object') {
    for (const [orderId, data] of Object.entries(shipments)) {
      await client.query(
        `INSERT INTO ops_shipments (order_id, data) VALUES ($1,$2)
         ON CONFLICT (order_id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`,
        [orderId, data],
      );
      bump('shipments');
    }
  }

  const catalog = readJson(path.join(DATA, 'catalog.json'));
  if (catalog && typeof catalog === 'object') {
    for (const [productId, data] of Object.entries(catalog)) {
      await client.query(
        `INSERT INTO ops_catalog_overrides (product_id, data) VALUES ($1,$2)
         ON CONFLICT (product_id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`,
        [productId, data],
      );
      bump('catalog');
    }
  }

  const cache = readJson(path.join(DATA, 'shopify-cache.json'));
  if (cache && Array.isArray(cache.products)) {
    await client.query(
      `INSERT INTO shopify_cache (id, data, synced_at) VALUES (1,$1,$2)
       ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, synced_at=EXCLUDED.synced_at, updated_at=now()`,
      [cache, typeof cache.syncedAt === 'string' ? cache.syncedAt : null],
    );
    bump('shopifyCache');
  }

  const status = readJson(path.join(DATA, 'shopify-sync-status.json'));
  if (status) {
    await client.query(
      `INSERT INTO shopify_sync_status (id, data) VALUES (1,$1) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`,
      [status],
    );
    bump('syncStatus');
  }
}

async function main() {
  if (!url && !process.env.PGHOST && !process.env.PGDATABASE) {
    console.error('未提供 DATABASE_URL，也没有 PG* 环境变量；无法连接数据库。');
    process.exit(2);
  }
  const client = await pool.connect();
  try {
    await applySchema();
    console.log('schema 已就绪');
    await client.query('BEGIN');
    await importEdm(client);
    await importOps(client);
    await client.query('COMMIT');
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
  console.log('迁移完成：', stats);
}

main()
  .then(() => pool.end())
  .catch((e) => {
    console.error('迁移失败：', e.message);
    pool.end().finally(() => process.exit(1));
  });
