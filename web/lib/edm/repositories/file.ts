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

// 文件存储实现：一个实体一个 JSON 文件，素材原图另存 <id>.bin。
// 所有 id 在拼路径前再校验一次；损坏文件按不存在处理，读取不抛出。

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
    listTemplates() {
      return listRecords('templates', isTemplateRecord).sort(compareUpdatedDesc);
    },
    getTemplate(id) {
      return getRecord('templates', id, isTemplateRecord);
    },
    putTemplate(t) {
      assertWritable(t, t?.id);
      writeJsonAtomic(fileOf('templates', t.id), t);
    },
    deleteTemplate(id) {
      removeFile(fileOf('templates', assertSafeRepositoryId(id)));
    },

    // 版本文件平铺在 versions/ 下：getVersion 只拿得到版本 id，不做模板子目录。
    listVersionMetas(templateId) {
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
    getVersion(id) {
      return getRecord('versions', id, isVersionRecord);
    },
    putVersion(v) {
      assertWritable(v, v?.id);
      writeJsonAtomic(fileOf('versions', v.id), v);
    },
    countVersions(templateId) {
      const safeId = assertSafeRepositoryId(templateId);
      let count = 0;
      for (const id of listIds('versions')) {
        if (!isSafeIdLike(id)) continue;
        const value = readJson<unknown>(fileOf('versions', id), null);
        if (isVersionRecord(value) && value.templateId === safeId) count += 1;
      }
      return count;
    },

    listCategories() {
      return readCategories();
    },
    putCategory(c) {
      assertWritable(c, c?.id);
      const value = structuredClone(c);
      return mutateCategories((list) => {
        const at = list.findIndex((x) => x.id === value.id);
        if (at === -1) return [...list, value];
        const next = [...list];
        next[at] = value;
        return next;
      });
    },
    deleteCategory(id) {
      const safeId = assertSafeRepositoryId(id);
      return mutateCategories((list) => list.filter((x) => x.id !== safeId));
    },
  };
}

function assetRepository(): AssetRepository {
  return {
    listAssets() {
      return listRecords('assets', isAssetRecord).sort(compareCreatedDesc);
    },
    getAsset(id) {
      return getRecord('assets', id, isAssetRecord);
    },
    putAsset(a) {
      assertWritable(a, a?.id);
      writeJsonAtomic(fileOf('assets', a.id), a);
    },
    deleteAsset(id) {
      const safeId = assertSafeRepositoryId(id);
      removeFile(fileOf('assets', safeId));
      removeFile(fileOf('assets', safeId, 'bin'));
    },
    readAssetBody(id) {
      const file = fileOf('assets', assertSafeRepositoryId(id), 'bin');
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) return null;
        return fs.readFileSync(file);
      } catch {
        return null;
      }
    },
    writeAssetBody(id, body) {
      const safeId = assertSafeRepositoryId(id);
      if (!Buffer.isBuffer(body)) throw new Error('非法写入数据');
      writeFileAtomic(fileOf('assets', safeId, 'bin'), body);
    },
  };
}

function audienceRepository(): AudienceRepository {
  return {
    listAudiences() {
      return listRecords('audiences', isAudienceRecord).sort(compareCreatedDesc);
    },
    getAudience(id) {
      return getRecord('audiences', id, isAudienceRecord);
    },
    putAudience(a) {
      assertWritable(a, a?.id);
      writeJsonAtomic(fileOf('audiences', a.id), a);
    },
  };
}

function preparationRepository(): PreparationRepository {
  return {
    listPreparations() {
      return listRecords('preparations', isPreparationRecord).sort(compareUpdatedDesc);
    },
    getPreparation(id) {
      return getRecord('preparations', id, isPreparationRecord);
    },
    putPreparation(p) {
      assertWritable(p, p?.id);
      writeJsonAtomic(fileOf('preparations', p.id), p);
    },
  };
}

function integrationRepository(): IntegrationRepository {
  return {
    read() {
      return normalizeIntegrations(readJson<unknown>(integrationsPath(), null)) ?? defaultIntegrations();
    },
    write(next) {
      const value = normalizeIntegrations(next);
      if (!value) throw new Error('非法写入数据');
      writeJsonAtomic(integrationsPath(), { ...value, schemaVersion: EDM_SCHEMA_VERSION });
    },
  };
}

function operationRepository(): OperationRepository {
  return {
    listOperations() {
      return listRecords('operations', isOperationRecord).sort(compareCreatedDesc);
    },
    getOperation(id) {
      return getRecord('operations', id, isOperationRecord);
    },
    putOperation(o) {
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