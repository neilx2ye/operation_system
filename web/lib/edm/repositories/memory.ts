import {
  EDM_SCHEMA_VERSION,
  type Asset,
  type AudienceSnapshot,
  type IntegrationsFile,
  type Operation,
  type Preparation,
  type Template,
  type TemplateCategory,
  type TemplateVersion,
} from '../types';
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

// 内存实现：测试与 OPS_EDM_MEMORY_STORE=1 的本地演练使用。
// 读写语义与 file.ts 对齐：同样排序、同样 bytes、写入与读取都做快照，避免调用方改到存储内容。

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createMemoryRepositories(seed: Partial<Repositories> = {}): Repositories {
  return {
    templates: seed.templates ?? memoryTemplates(),
    assets: seed.assets ?? memoryAssets(),
    audiences: seed.audiences ?? memoryAudiences(),
    preparations: seed.preparations ?? memoryPreparations(),
    integrations: seed.integrations ?? memoryIntegrations(),
    operations: seed.operations ?? memoryOperations(),
  };
}

function memoryTemplates(): TemplateRepository {
  const templates = new Map<string, Template>();
  const versions = new Map<string, TemplateVersion>();
  const categories = new Map<string, TemplateCategory>();

  return {
    listTemplates() {
      return [...templates.values()].filter(isTemplateRecord).map(clone).sort(compareUpdatedDesc);
    },
    getTemplate(id) {
      const value = templates.get(assertSafeRepositoryId(id));
      return value && isTemplateRecord(value) ? clone(value) : null;
    },
    putTemplate(t) {
      assertWritable(t, t?.id);
      templates.set(t.id, clone(t));
    },
    deleteTemplate(id) {
      templates.delete(assertSafeRepositoryId(id));
    },
    listVersionMetas(templateId) {
      const safeId = assertSafeRepositoryId(templateId);
      return [...versions.values()]
        .filter((v) => isVersionRecord(v) && v.templateId === safeId)
        .map(toVersionMeta)
        .sort(compareCreatedAsc);
    },
    getVersion(id) {
      const value = versions.get(assertSafeRepositoryId(id));
      return value && isVersionRecord(value) ? clone(value) : null;
    },
    putVersion(v) {
      assertWritable(v, v?.id);
      versions.set(v.id, clone(v));
    },
    countVersions(templateId) {
      const safeId = assertSafeRepositoryId(templateId);
      let count = 0;
      for (const v of versions.values()) if (isVersionRecord(v) && v.templateId === safeId) count += 1;
      return count;
    },
    listCategories() {
      return [...categories.values()].filter(isCategoryRecord).map(clone);
    },
    putCategory(c) {
      assertWritable(c, c?.id);
      categories.set(c.id, clone(c));
    },
    deleteCategory(id) {
      categories.delete(assertSafeRepositoryId(id));
    },
  };
}

function memoryAssets(): AssetRepository {
  const assets = new Map<string, Asset>();
  const bodies = new Map<string, Buffer>();

  return {
    listAssets() {
      return [...assets.values()].filter(isAssetRecord).map(clone).sort(compareCreatedDesc);
    },
    getAsset(id) {
      const value = assets.get(assertSafeRepositoryId(id));
      return value && isAssetRecord(value) ? clone(value) : null;
    },
    putAsset(a) {
      assertWritable(a, a?.id);
      assets.set(a.id, clone(a));
    },
    deleteAsset(id) {
      const safeId = assertSafeRepositoryId(id);
      assets.delete(safeId);
      bodies.delete(safeId);
    },
    readAssetBody(id) {
      const body = bodies.get(assertSafeRepositoryId(id));
      return body ? Buffer.from(body) : null;
    },
    writeAssetBody(id, body) {
      const safeId = assertSafeRepositoryId(id);
      if (!Buffer.isBuffer(body)) throw new Error('非法写入数据');
      bodies.set(safeId, Buffer.from(body));
    },
  };
}

function memoryAudiences(): AudienceRepository {
  const audiences = new Map<string, AudienceSnapshot>();

  return {
    listAudiences() {
      return [...audiences.values()].filter(isAudienceRecord).map(clone).sort(compareCreatedDesc);
    },
    getAudience(id) {
      const value = audiences.get(assertSafeRepositoryId(id));
      return value && isAudienceRecord(value) ? clone(value) : null;
    },
    putAudience(a) {
      assertWritable(a, a?.id);
      audiences.set(a.id, clone(a));
    },
  };
}

function memoryPreparations(): PreparationRepository {
  const preparations = new Map<string, Preparation>();

  return {
    listPreparations() {
      return [...preparations.values()].filter(isPreparationRecord).map(clone).sort(compareUpdatedDesc);
    },
    getPreparation(id) {
      const value = preparations.get(assertSafeRepositoryId(id));
      return value && isPreparationRecord(value) ? clone(value) : null;
    },
    putPreparation(p) {
      assertWritable(p, p?.id);
      preparations.set(p.id, clone(p));
    },
  };
}

function memoryIntegrations(): IntegrationRepository {
  let stored: IntegrationsFile | null = null;

  return {
    read() {
      return stored ? clone(stored) : defaultIntegrations();
    },
    write(next) {
      const value = normalizeIntegrations(next);
      if (!value) throw new Error('非法写入数据');
      stored = clone({ ...value, schemaVersion: EDM_SCHEMA_VERSION });
    },
  };
}

function memoryOperations(): OperationRepository {
  const operations = new Map<string, Operation>();

  return {
    listOperations() {
      return [...operations.values()].filter(isOperationRecord).map(clone).sort(compareCreatedDesc);
    },
    getOperation(id) {
      const value = operations.get(assertSafeRepositoryId(id));
      return value && isOperationRecord(value) ? clone(value) : null;
    },
    putOperation(o) {
      assertWritable(o, o?.id);
      operations.set(o.id, clone(o));
    },
  };
}