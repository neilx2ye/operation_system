import { dbOne, dbRows, withTx } from '@/lib/db/pool';
import { broadcastReload } from '@/lib/hotReload';
import { EDM_SCHEMA_VERSION, type TemplateVersion, type TemplateVersionMeta } from '../types';
import {
  assertSafeRepositoryId,
  assertWritable,
  defaultIntegrations,
  isAssetRecord,
  isAudienceRecord,
  isCategoryRecord,
  isOperationRecord,
  isPreparationRecord,
  isTemplateRecord,
  isVersionRecord,
  normalizeIntegrations,
  toVersionMeta,
} from './shared';
import type {
  AssetRepository,
  AudienceRepository,
  IntegrationRepository,
  OperationRepository,
  PreparationRepository,
  Repositories,
  TemplateRepository,
} from './types';

// PostgreSQL 存储实现。实体整体以 jsonb 往返，排序所需的键抽成独立列。
// 排序用 COLLATE "C" 按字节比较 ISO 时间串，与旧文件实现的字符串排序逐条一致。

type Row = { data: unknown };

/** 写入后广播一次数据层变更，让开发环境里打开的页面自动刷新（生产为 no-op）。 */
async function write(sql: string, params: unknown[] = []): Promise<void> {
  await dbRows(sql, params);
  broadcastReload('edm');
}


/** 只返回通过形状检查的行，与 file/memory 实现保持同样的健壮性 */
function pick<T>(rows: Row[], shaped: (v: unknown) => v is T): T[] {
  const out: T[] = [];
  for (const r of rows) if (shaped(r.data)) out.push(r.data);
  return out;
}

function templateRepository(): TemplateRepository {
  return {
    async listTemplates() {
      const rows = await dbRows<Row>(
        `SELECT data FROM edm_templates ORDER BY coalesce(updated_at,'') COLLATE "C" DESC, id COLLATE "C" ASC`,
      );
      return pick(rows, isTemplateRecord);
    },
    async getTemplate(id) {
      const row = await dbOne<Row>('SELECT data FROM edm_templates WHERE id = $1', [assertSafeRepositoryId(id)]);
      return row && isTemplateRecord(row.data) ? row.data : null;
    },
    async putTemplate(t) {
      assertWritable(t, t?.id);
      await write(
        `INSERT INTO edm_templates (id, current_version_id, updated_at, created_at, data)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET
           current_version_id = EXCLUDED.current_version_id,
           updated_at = EXCLUDED.updated_at,
           created_at = EXCLUDED.created_at,
           data = EXCLUDED.data`,
        [t.id, t.currentVersionId, t.updatedAt ?? null, t.createdAt ?? null, t],
      );
    },
    async deleteTemplate(id) {
      const safeId = assertSafeRepositoryId(id);
      await withTx(async (c) => {
        await c.query('DELETE FROM edm_template_versions WHERE template_id = $1', [safeId]);
        await c.query('DELETE FROM edm_templates WHERE id = $1', [safeId]);
      });
      broadcastReload('edm');
    },

    async listVersionMetas(templateId) {
      const safeId = assertSafeRepositoryId(templateId);
      const rows = await dbRows<Row>(
        `SELECT data FROM edm_template_versions
         WHERE template_id = $1
         ORDER BY coalesce(created_at,'') COLLATE "C" ASC, id COLLATE "C" ASC`,
        [safeId],
      );
      const versions = pick(rows, isVersionRecord);
      return versions.map((v: TemplateVersion): TemplateVersionMeta => toVersionMeta(v));
    },
    async getVersion(id) {
      const row = await dbOne<Row>('SELECT data FROM edm_template_versions WHERE id = $1', [assertSafeRepositoryId(id)]);
      return row && isVersionRecord(row.data) ? row.data : null;
    },
    async putVersion(v) {
      assertWritable(v, v?.id);
      await write(
        `INSERT INTO edm_template_versions (id, template_id, created_at, data)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET
           template_id = EXCLUDED.template_id,
           created_at = EXCLUDED.created_at,
           data = EXCLUDED.data`,
        [v.id, v.templateId, v.createdAt ?? null, v],
      );
    },
    async countVersions(templateId) {
      const safeId = assertSafeRepositoryId(templateId);
      const row = await dbOne<{ n: string }>('SELECT count(*)::text AS n FROM edm_template_versions WHERE template_id = $1', [safeId]);
      return row ? Number(row.n) : 0;
    },

    async listCategories() {
      const rows = await dbRows<Row>('SELECT data FROM edm_template_categories ORDER BY seq ASC, id COLLATE "C" ASC');
      return pick(rows, isCategoryRecord);
    },
    async putCategory(c) {
      assertWritable(c, c?.id);
      await write(
        `INSERT INTO edm_template_categories (id, data) VALUES ($1,$2)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
        [c.id, c],
      );
    },
    async deleteCategory(id) {
      await write('DELETE FROM edm_template_categories WHERE id = $1', [assertSafeRepositoryId(id)]);
    },
  };
}

function assetRepository(): AssetRepository {
  return {
    async listAssets() {
      const rows = await dbRows<Row>(
        `SELECT data FROM edm_assets WHERE data IS NOT NULL
         ORDER BY coalesce(created_at,'') COLLATE "C" DESC, id COLLATE "C" ASC`,
      );
      return pick(rows, isAssetRecord);
    },
    async getAsset(id) {
      const row = await dbOne<Row>('SELECT data FROM edm_assets WHERE id = $1 AND data IS NOT NULL', [assertSafeRepositoryId(id)]);
      return row && isAssetRecord(row.data) ? row.data : null;
    },
    async putAsset(a) {
      assertWritable(a, a?.id);
      await write(
        `INSERT INTO edm_assets (id, created_at, data) VALUES ($1,$2,$3)
         ON CONFLICT (id) DO UPDATE SET created_at = EXCLUDED.created_at, data = EXCLUDED.data`,
        [a.id, a.createdAt ?? null, a],
      );
    },
    async deleteAsset(id) {
      await write('DELETE FROM edm_assets WHERE id = $1', [assertSafeRepositoryId(id)]);
    },
    async readAssetBody(id) {
      const row = await dbOne<{ body: Buffer | null }>('SELECT body FROM edm_assets WHERE id = $1', [assertSafeRepositoryId(id)]);
      return row?.body ? Buffer.from(row.body) : null;
    },
    async writeAssetBody(id, body) {
      const safeId = assertSafeRepositoryId(id);
      if (!Buffer.isBuffer(body)) throw new Error('非法写入数据');
      await write(
        `INSERT INTO edm_assets (id, body) VALUES ($1,$2)
         ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body`,
        [safeId, body],
      );
    },
  };
}

function audienceRepository(): AudienceRepository {
  return {
    async listAudiences() {
      const rows = await dbRows<Row>(
        `SELECT data FROM edm_audiences ORDER BY coalesce(created_at,'') COLLATE "C" DESC, id COLLATE "C" ASC`,
      );
      return pick(rows, isAudienceRecord);
    },
    async getAudience(id) {
      const row = await dbOne<Row>('SELECT data FROM edm_audiences WHERE id = $1', [assertSafeRepositoryId(id)]);
      return row && isAudienceRecord(row.data) ? row.data : null;
    },
    async putAudience(a) {
      assertWritable(a, a?.id);
      await write(
        `INSERT INTO edm_audiences (id, created_at, expires_at, data) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at, data = EXCLUDED.data`,
        [a.id, a.createdAt ?? null, a.expiresAt ?? null, a],
      );
    },
    async deleteAudience(id) {
      await write('DELETE FROM edm_audiences WHERE id = $1', [assertSafeRepositoryId(id)]);
    },
  };
}

function preparationRepository(): PreparationRepository {
  return {
    async listPreparations() {
      const rows = await dbRows<Row>(
        `SELECT data FROM edm_preparations ORDER BY coalesce(updated_at,'') COLLATE "C" DESC, id COLLATE "C" ASC`,
      );
      return pick(rows, isPreparationRecord);
    },
    async getPreparation(id) {
      const row = await dbOne<Row>('SELECT data FROM edm_preparations WHERE id = $1', [assertSafeRepositoryId(id)]);
      return row && isPreparationRecord(row.data) ? row.data : null;
    },
    async putPreparation(p) {
      assertWritable(p, p?.id);
      await write(
        `INSERT INTO edm_preparations (id, updated_at, data) VALUES ($1,$2,$3)
         ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at, data = EXCLUDED.data`,
        [p.id, p.updatedAt ?? null, p],
      );
    },
  };
}

function integrationRepository(): IntegrationRepository {
  return {
    async read() {
      const row = await dbOne<Row>('SELECT data FROM edm_integrations WHERE id = 1');
      if (!row) return defaultIntegrations();
      return normalizeIntegrations(row.data) ?? defaultIntegrations();
    },
    async write(next) {
      const value = normalizeIntegrations(next);
      if (!value) throw new Error('非法写入数据');
      await write(
        `INSERT INTO edm_integrations (id, data) VALUES (1,$1)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [{ ...value, schemaVersion: EDM_SCHEMA_VERSION }],
      );
    },
  };
}

function operationRepository(): OperationRepository {
  return {
    async listOperations() {
      const rows = await dbRows<Row>(
        `SELECT data FROM edm_operations ORDER BY coalesce(created_at,'') COLLATE "C" DESC, id COLLATE "C" ASC`,
      );
      return pick(rows, isOperationRecord);
    },
    async getOperation(id) {
      const row = await dbOne<Row>('SELECT data FROM edm_operations WHERE id = $1', [assertSafeRepositoryId(id)]);
      return row && isOperationRecord(row.data) ? row.data : null;
    },
    async putOperation(o) {
      assertWritable(o, o?.id);
      await write(
        `INSERT INTO edm_operations (id, created_at, data) VALUES ($1,$2,$3)
         ON CONFLICT (id) DO UPDATE SET created_at = EXCLUDED.created_at, data = EXCLUDED.data`,
        [o.id, o.createdAt ?? null, o],
      );
    },
  };
}

export function createPostgresRepositories(): Repositories {
  return {
    templates: templateRepository(),
    assets: assetRepository(),
    audiences: audienceRepository(),
    preparations: preparationRepository(),
    integrations: integrationRepository(),
    operations: operationRepository(),
  };
}
