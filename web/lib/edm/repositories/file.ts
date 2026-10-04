import fs from 'node:fs';
import path from 'node:path';

import {
  edmDataDir,
  fileOf,
  listIds,
  readJson,
  removeFile,
  withLock,
  writeFileAtomic,
  writeJsonAtomic,
  type DirKind,
} from '../storage';
import { EDM_SCHEMA_VERSION, type TemplateCategory, type TemplateVersionMeta } from '../types';
import {
  assertSafeRepositoryId,
  assertWritable,
  compareCreatedAsc,
  compareCreatedDesc,
  compareUpdatedDesc,
  defaultIntegrations,
  isAssetRecord,
  isAudienceRecord,
  isCategoryRecord,
  isOperationRecord,
  isPreparationRecord,
  isRecord,
  isSafeIdLike,
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

// 文件存储实现（回滚/离线用）：一个实体一个 JSON 文件，素材原图另存 <id>.bin。
// 所有 id 在拼路径前再校验一次；损坏文件按不存在处理，读取不抛出。
// 方法保持同步 fs 调用，但对外统一返回 Promise，与 postgres/memory 实现形态一致。

type CategoryIndex = {
  schemaVersion: number;
  categories: TemplateCategory[];
  updatedAt: string;
};

const CATEGORY_INDEX = 'index.json';
const INTEGRATIONS = 'integrations.json';

function indexPath(): string {
  return path.join(edmDataDir(), CATEGORY_INDEX);
}

function integrationsPath(): string {
  return path.join(edmDataDir(), INTEGRATIONS);
}

/** 目录下所有通过形状检查的记录；损坏或非法命名的文件直接跳过 */
function listRecords<T>(kind: DirKind, shaped: (value: unknown) => value is T): T[] {
  const out: T[] = [];
  for (const id of listIds(kind)) {
    if (!isSafeIdLike(id)) continue;
    const value = readJson<unknown>(fileOf(kind, id), null);
    if (shaped(value)) out.push(value);
  }
  return out;
}

function getRecord<T>(kind: DirKind, id: unknown, shaped: (value: unknown) => value is T): T | null {
  const safeId = assertSafeRepositoryId(id);
  const value = readJson<unknown>(fileOf(kind, safeId), null);
  return shaped(value) ? value : null;
}

function readCategories(): TemplateCategory[] {
  const raw = readJson<unknown>(indexPath(), null);
  if (!isRecord(raw) || !Array.isArray(raw.categories)) return [];
  return raw.categories.filter(isCategoryRecord);
}

/** index.json 是多字段共用一个文件，读改写必须串行，否则并发写互相覆盖 */
function mutateCategories(mutate: (list: TemplateCategory[]) => TemplateCategory[]): Promise<void> {
  return withLock('index', () => {
    const next: CategoryIndex = {
      schemaVersion: EDM_SCHEMA_VERSION,
      categories: mutate(readCategories()),
      updatedAt: new Date().toISOString(),
    };
    writeJsonAtomic(indexPath(), next);
  });
}

function templateRepository(): TemplateRepository {
  return {
    async listTemplates() {
      return listRecords('templates', isTemplateRecord).sort(compareUpdatedDesc);
    },
    async getTemplate(id) {
      return getRecord('templates', id, isTemplateRecord);
    },
    async putTemplate(t) {
      assertWritable(t, t?.id);
      writeJsonAtomic(fileOf('templates', t.id), t);
    },
    async deleteTemplate(id) {
      const safeId = assertSafeRepositoryId(id);
      removeFile(fileOf('templates', safeId));
      // 版本文件随模板一起清理，避免孤儿版本被素材引用检查误判
      for (const vid of listIds('versions')) {
        if (!isSafeIdLike(vid)) continue;
        const value = readJson<unknown>(fileOf('versions', vid), null);
        if (isVersionRecord(value) && value.templateId === safeId) removeFile(fileOf('versions', vid));
      }
    },

    // 版本文件平铺在 versions/ 下：getVersion 只拿得到版本 id，不做模板子目录。
    async listVersionMetas(templateId) {
      const safeId = assertSafeRepositoryId(templateId);
      const out: TemplateVersionMeta[] = [];
      for (const id of listIds('versions')) {
        if (!isSafeIdLike(id)) continue;
        const value = readJson<unknown>(fileOf('versions', id), null);
        if (!isVersionRecord(value) || value.templateId !== safeId) continue;
        out.push(toVersionMeta(value));
      }
      return out.sort(compareCreatedAsc);
    },
    async getVersion(id) {
      return getRecord('versions', id, isVersionRecord);
    },
    async putVersion(v) {
      assertWritable(v, v?.id);
      writeJsonAtomic(fileOf('versions', v.id), v);
    },
    async countVersions(templateId) {
      const safeId = assertSafeRepositoryId(templateId);
      let count = 0;
      for (const id of listIds('versions')) {
        if (!isSafeIdLike(id)) continue;
        const value = readJson<unknown>(fileOf('versions', id), null);
        if (isVersionRecord(value) && value.templateId === safeId) count += 1;
      }
      return count;
    },

    async listCategories() {
      return readCategories();
    },
    async putCategory(c) {
      assertWritable(c, c?.id);
      const value = structuredClone(c);
      await mutateCategories((list) => {
        const at = list.findIndex((x) => x.id === value.id);
        if (at === -1) return [...list, value];
        const next = [...list];
        next[at] = value;
        return next;
      });
    },
    async deleteCategory(id) {
      const safeId = assertSafeRepositoryId(id);
      await mutateCategories((list) => list.filter((x) => x.id !== safeId));
    },
  };
}

function assetRepository(): AssetRepository {
  return {
    async listAssets() {
      return listRecords('assets', isAssetRecord).sort(compareCreatedDesc);
    },
    async getAsset(id) {
      return getRecord('assets', id, isAssetRecord);
    },
    async putAsset(a) {
      assertWritable(a, a?.id);
      writeJsonAtomic(fileOf('assets', a.id), a);
    },
    async deleteAsset(id) {
      const safeId = assertSafeRepositoryId(id);
      removeFile(fileOf('assets', safeId));
      removeFile(fileOf('assets', safeId, 'bin'));
    },
    async readAssetBody(id) {
      const file = fileOf('assets', assertSafeRepositoryId(id), 'bin');
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) return null;
        return fs.readFileSync(file);
      } catch {
        return null;
      }
    },
    async writeAssetBody(id, body) {
      const safeId = assertSafeRepositoryId(id);
      if (!Buffer.isBuffer(body)) throw new Error('非法写入数据');
      writeFileAtomic(fileOf('assets', safeId, 'bin'), body);
    },
  };
}

function audienceRepository(): AudienceRepository {
  return {
    async listAudiences() {
      return listRecords('audiences', isAudienceRecord).sort(compareCreatedDesc);
    },
    async getAudience(id) {
      return getRecord('audiences', id, isAudienceRecord);
    },
    async putAudience(a) {
      assertWritable(a, a?.id);
      writeJsonAtomic(fileOf('audiences', a.id), a);
    },
    async deleteAudience(id) {
      removeFile(fileOf('audiences', assertSafeRepositoryId(id)));
    },
  };
}

function preparationRepository(): PreparationRepository {
  return {
    async listPreparations() {
      return listRecords('preparations', isPreparationRecord).sort(compareUpdatedDesc);
    },
    async getPreparation(id) {
      return getRecord('preparations', id, isPreparationRecord);
    },
    async putPreparation(p) {
      assertWritable(p, p?.id);
      writeJsonAtomic(fileOf('preparations', p.id), p);
    },
  };
}

function integrationRepository(): IntegrationRepository {
  return {
    async read() {
      return normalizeIntegrations(readJson<unknown>(integrationsPath(), null)) ?? defaultIntegrations();
    },
    async write(next) {
      const value = normalizeIntegrations(next);
      if (!value) throw new Error('非法写入数据');
      writeJsonAtomic(integrationsPath(), { ...value, schemaVersion: EDM_SCHEMA_VERSION });
    },
  };
}

function operationRepository(): OperationRepository {
  return {
    async listOperations() {
      return listRecords('operations', isOperationRecord).sort(compareCreatedDesc);
    },
    async getOperation(id) {
      return getRecord('operations', id, isOperationRecord);
    },
    async putOperation(o) {
      assertWritable(o, o?.id);
      writeJsonAtomic(fileOf('operations', o.id), o);
    },
  };
}

export function createFileRepositories(): Repositories {
  return {
    templates: templateRepository(),
    assets: assetRepository(),
    audiences: audienceRepository(),
    preparations: preparationRepository(),
    integrations: integrationRepository(),
    operations: operationRepository(),
  };
}
