import {
  EDM_SCHEMA_VERSION,
  type Asset,
  type AudienceSnapshot,
  type IntegrationsFile,
  type KlaviyoBinding,
  type KlaviyoIdentityMap,
  type KlaviyoListRecord,
  type KlaviyoMarketingStatus,
  type Operation,
  type Preparation,
  type RemoteTemplateRecord,
  type Template,
  type TemplateCategory,
  type TemplateVersion,
  type TemplateVersionMeta,
} from '../types';

// file / memory 两种存储实现共用的形状检查、排序规则与默认值。
// 放在这里是为了让同一份输入在两种实现下得到逐条一致的结果。

const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSafeIdLike(id: unknown): id is string {
  return typeof id === 'string' && SAFE_ID_RE.test(id);
}

/** id 会被拼进文件路径，越界形态一律拒绝 */
export function assertSafeRepositoryId(id: unknown): string {
  if (!isSafeIdLike(id)) throw new Error('非法 ID');
  return id;
}

/** 写入兜底：非对象、非法 id 不得落盘 */
export function assertWritable(value: unknown, id: unknown): void {
  if (!isRecord(value)) throw new Error('非法写入数据');
  assertSafeRepositoryId(id);
}

// ---------- 形状检查 ----------
// 只校验读取路径真正依赖的字段：id 用于定位与分组，html 用于计算 bytes。

export function isTemplateRecord(value: unknown): value is Template {
  return isRecord(value) && isSafeIdLike(value.id) && isSafeIdLike(value.currentVersionId);
}

export function isVersionRecord(value: unknown): value is TemplateVersion {
  return isRecord(value) && isSafeIdLike(value.id) && isSafeIdLike(value.templateId) && typeof value.html === 'string';
}

export function isCategoryRecord(value: unknown): value is TemplateCategory {
  return isRecord(value) && isSafeIdLike(value.id);
}

export function isAssetRecord(value: unknown): value is Asset {
  return isRecord(value) && isSafeIdLike(value.id);
}

export function isAudienceRecord(value: unknown): value is AudienceSnapshot {
  return isRecord(value) && isSafeIdLike(value.id);
}

export function isPreparationRecord(value: unknown): value is Preparation {
  return isRecord(value) && isSafeIdLike(value.id);
}

export function isOperationRecord(value: unknown): value is Operation {
  return isRecord(value) && isSafeIdLike(value.id);
}

/** 列表只回传元数据：丢弃 HTML 正文，改为字节数 */
export function toVersionMeta(version: TemplateVersion): TemplateVersionMeta {
  const { html, ...rest } = version;
  return { ...rest, bytes: Buffer.byteLength(html) };
}

// ---------- 排序 ----------
// 时间字段相同或缺失时用 id 升序兜底，避免目录返回顺序影响结果。

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function compareTextAsc(a: unknown, b: unknown): number {
  const x = textOf(a);
  const y = textOf(b);
  return x === y ? 0 : x < y ? -1 : 1;
}

export function compareTextDesc(a: unknown, b: unknown): number {
  const x = textOf(a);
  const y = textOf(b);
  return x === y ? 0 : x < y ? 1 : -1;
}

export function compareCreatedAsc<T extends { id: string; createdAt: unknown }>(a: T, b: T): number {
  return compareTextAsc(a.createdAt, b.createdAt) || compareTextAsc(a.id, b.id);
}

export function compareCreatedDesc<T extends { id: string; createdAt: unknown }>(a: T, b: T): number {
  return compareTextDesc(a.createdAt, b.createdAt) || compareTextAsc(a.id, b.id);
}

export function compareUpdatedDesc<T extends { id: string; updatedAt: unknown }>(a: T, b: T): number {
  return compareTextDesc(a.updatedAt, b.updatedAt) || compareTextAsc(a.id, b.id);
}

// ---------- Klaviyo 集成文件 ----------

/** 每次调用都返回全新对象；apiRevision 跟随当前环境变量 */
export function defaultIntegrations(): IntegrationsFile {
  return {
    schemaVersion: EDM_SCHEMA_VERSION,
    klaviyo: {
      binding: {
        accountId: null,
        accountLabel: '',
        apiRevision: process.env.KLAVIYO_API_REVISION?.trim() || '2026-07-15',
        storeKey: '',
        defaultListId: null,
        defaultListName: '',
        writesEnabled: false,
        lastCheckedAt: null,
        lastCheck: null,
      },
      identities: {},
      remoteTemplates: {},
      lists: [],
      marketing: {},
    },
  };
}

/** 形状检查并补齐缺失的 klaviyo 子键；整体不可用时返回 null */
export function normalizeIntegrations(value: unknown): IntegrationsFile | null {
  if (!isRecord(value) || !isRecord(value.klaviyo)) return null;
  const klaviyo = value.klaviyo;
  const base = defaultIntegrations();
  return {
    schemaVersion: typeof value.schemaVersion === 'number' ? value.schemaVersion : base.schemaVersion,
    klaviyo: {
      binding: isRecord(klaviyo.binding) ? (klaviyo.binding as KlaviyoBinding) : base.klaviyo.binding,
      identities: isRecord(klaviyo.identities) ? (klaviyo.identities as KlaviyoIdentityMap) : base.klaviyo.identities,
      remoteTemplates: isRecord(klaviyo.remoteTemplates)
        ? (klaviyo.remoteTemplates as Record<string, RemoteTemplateRecord>)
        : base.klaviyo.remoteTemplates,
      lists: Array.isArray(klaviyo.lists) ? (klaviyo.lists as KlaviyoListRecord[]) : base.klaviyo.lists,
      marketing: isRecord(klaviyo.marketing) ? (klaviyo.marketing as Record<string, KlaviyoMarketingStatus>) : base.klaviyo.marketing,
    },
  };
}