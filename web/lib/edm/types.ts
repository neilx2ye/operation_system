// EDM 模板设计器的本地数据契约。
// 本期不接入数据库：页面只依赖 lib/edm/service.ts，具体存储由 lib/edm/repositories/ 提供。
// 所有时间字段统一为 ISO 字符串，所有 id 由 lib/edm/ids.ts 生成并校验。

export type Id = string;

export const EDM_SCHEMA_VERSION = 1;

// ---------- 分类 ----------

export type TemplateCategory = {
  id: Id;
  name: string;
  order: number;
  createdAt: string;
};

// ---------- 模板 ----------

export type TemplateOrigin = 'blank' | 'import' | 'klaviyo';
export type TemplateStatus = 'draft' | 'ready' | 'archived';

/** 远端模板绑定；没有明确建立映射的模板不允许更新远端 */
export type RemoteTemplateLink = {
  accountId: string;
  remoteId: string;
  syncedAt: string;
  /** 远端最近一次已知指纹，用于推送前冲突检测 */
  remoteFingerprint: string | null;
};

/** 模板元数据。HTML 正文永远存在 TemplateVersion 里，保持不可变。 */
export type Template = {
  id: Id;
  name: string;
  categoryId: Id | null;
  /** 可选店铺标签，只用于筛选，不承载旧 EDM 的项目权限含义 */
  storeKey: string;
  subject: string;
  previewText: string;
  status: TemplateStatus;
  currentVersionId: Id;
  /** 乐观并发版本号：每次成功写入 +1，冲突返回 409 */
  revision: number;
  origin: TemplateOrigin;
  remote: RemoteTemplateLink | null;
  createdAt: string;
  updatedAt: string;
};

export type VersionSource = 'initial' | 'manual' | 'import' | 'rollback' | 'klaviyo';

/** 不可变的 HTML 快照。回滚不改写旧版本，而是生成一个新版本。 */
export type TemplateVersion = {
  id: Id;
  templateId: Id;
  html: string;
  /** sha256(html) */
  hash: string;
  note: string;
  source: VersionSource;
  /** 回滚来源，便于追溯 */
  fromVersionId: Id | null;
  createdAt: string;
};

/** 版本列表用的轻量结构，不含 HTML 正文 */
export type TemplateVersionMeta = Omit<TemplateVersion, 'html'> & { bytes: number };

export type CreateTemplateInput = {
  name: string;
  categoryId?: Id | null;
  storeKey?: string;
  subject?: string;
  previewText?: string;
  html?: string;
  origin?: TemplateOrigin;
  note?: string;
  /** 从 Klaviyo 拉取的模板：建立远端绑定，便于后续推送回同一模板 */
  remote?: RemoteTemplateLink | null;
};

export type UpdateTemplateInput = {
  name?: string;
  categoryId?: Id | null;
  storeKey?: string;
  subject?: string;
  previewText?: string;
  status?: TemplateStatus;
  /** 旧版本号；不一致时服务端返回 409 */
  revision: number;
};

// ---------- 素材 ----------

export const ASSET_MIME = ['image/jpeg', 'image/png', 'image/gif'] as const;
export type AssetMime = (typeof ASSET_MIME)[number];
/** 与当前 Klaviyo 文件上传接口一致；旧 EDM 的 WebP/10MB 规则不适用 */
export const ASSET_MAX_BYTES = 5 * 1024 * 1024;

export type Asset = {
  id: Id;
  filename: string;
  mime: AssetMime;
  size: number;
  /** sha256(bytes) */
  hash: string;
  /** 设计预览用的 OPS 本地地址，形如 /api/edm/assets/<id> */
  path: string;
  /** 上传到 Klaviyo 后的公开地址 */
  uploaded: { accountId: string; url: string; uploadedAt: string } | null;
  createdAt: string;
};

// ---------- 受众快照 ----------

export type AudienceSelectionMode = 'ids' | 'filters';
export type AudienceDataSource = 'mock' | 'shopify';

/** 筛选条件摘要。自由搜索可能含邮箱，因此只存哈希，不落盘明文。 */
export type AudienceFilterSummary = {
  segment?: string;
  source?: string;
  country?: string;
  cohort?: string;
  abandon?: string;
  /** '__none__' 表示未打标签 */
  tag?: string | null;
  queryHash?: string;
};

export type AudienceCounts = {
  total: number;
  validEmail: number;
  duplicateEmail: number;
  /**
   * 可用于营销数 / 待确认数：依赖 Klaviyo 订阅与抑制状态。
   * 快照生成时按当时已知的状态缓存计算；未知状态一律计入 pending。
   */
  mailable: number;
  pending: number;
};

export type AudienceExclusionReason =
  | 'not_found'
  | 'outside_source'
  | 'no_email'
  | 'placeholder_email'
  | 'invalid_email'
  | 'duplicate_email'
  | 'mock_source';

export type AudienceSnapshot = {
  id: Id;
  storeKey: string;
  dataSource: AudienceDataSource;
  sourceRevision: string;
  sourceSyncedAt: string | null;
  mode: AudienceSelectionMode;
  filters: AudienceFilterSummary;
  /** 生成时命中的本地客户 ID；不含邮箱等 PII */
  customerIds: Id[];
  counts: AudienceCounts;
  excluded: { reason: AudienceExclusionReason; count: number }[];
  /** 生成时使用同一份数据源的幂等标记，便于诊断 */
  createdAt: string;
  expiresAt: string;
  /** 快照失效时记录原因，页面需要重新确认 */
  invalidatedAt: string | null;
  invalidReason: string | null;
};

// ---------- 邮件准备记录 ----------

/** 模板版本 + 受众的组合，用于本地留档。不是 Klaviyo Campaign，也不代表已发送。 */
export type Preparation = {
  id: Id;
  templateId: Id;
  versionId: Id;
  audienceId: Id;
  subject: string;
  previewText: string;
  accountId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreatePreparationInput = {
  templateId: Id;
  versionId?: Id;
  audienceId: Id;
  subject?: string;
  previewText?: string;
  accountId?: string | null;
};

// ---------- Klaviyo 绑定与映射 ----------

export type KlaviyoBinding = {
  /** 由 GET /api/accounts 核对得到 */
  accountId: string | null;
  accountLabel: string;
  apiRevision: string;
  storeKey: string;
  defaultListId: string | null;
  defaultListName: string;
  /** 本地写入开关；真实写入还要求服务端 KLAVIYO_ENABLE_WRITES=true */
  writesEnabled: boolean;
  lastCheckedAt: string | null;
  lastCheck: { ok: boolean; detail: string } | null;
};

/** 订阅 / 抑制状态缓存。未知状态默认排除，不参与名单同步。 */
export type KlaviyoMarketingStatus = {
  canReceiveEmail: boolean | null;
  subscribed: boolean | null;
  /**
   * 原始 consent 字符串。官方没有为读取侧声明枚举，因此保留原值：
   * 只把 SUBSCRIBED / UNSUBSCRIBED 解释成明确的是/否，其余（含 NEVER_SUBSCRIBED）按未知处理。
   */
  consent?: string | null;
  globalSuppressed: boolean | null;
  listSuppressed: boolean | null;
  /** 全局抑制原因，来自 suppression[].reason */
  suppressionReasons?: string[];
  /** 名单级抑制涉及的名单 ID，来自 list_suppressions[].list_id */
  listSuppressionIds?: string[];
  /** 明确查询到状态的时间 */
  checkedAt: string;
};

export type KlaviyoIdentity = {
  profileId: string;
  /** 规范化邮箱，仅服务端使用，不回传前端 */
  email: string;
  verifiedAt: string;
  source: 'lookup' | 'import' | 'list';
};

export type KlaviyoIdentityMap = Record<string, KlaviyoIdentity>;

export type RemoteTemplateRecord = {
  remoteId: string;
  name: string;
  fingerprint: string | null;
  checkedAt: string;
};

export type KlaviyoListRecord = { id: string; name: string; profileCount: number | null; fetchedAt: string };

export type IntegrationsFile = {
  schemaVersion: number;
  klaviyo: {
    binding: KlaviyoBinding;
    /** key = `${storeKey}|${accountId}|${opsCustomerId}` */
    identities: KlaviyoIdentityMap;
    /** key = 本地 templateId */
    remoteTemplates: Record<string, RemoteTemplateRecord>;
    lists: KlaviyoListRecord[];
    /** key 与 identities 相同 */
    marketing: Record<string, KlaviyoMarketingStatus>;
  };
};

// ---------- 执行记录 ----------

export type OperationKind = 'template_sync' | 'image_upload' | 'profile_sync' | 'list_sync';
export type OperationStatus = 'pending' | 'running' | 'done' | 'partial' | 'failed' | 'unknown' | 'awaiting_resume';
export type StepStatus = 'ok' | 'skip' | 'fail' | 'unknown';

export type OperationStep = {
  name: string;
  status: StepStatus;
  count: number | null;
  detail: string;
  at: string;
};

export type Operation = {
  id: Id;
  kind: OperationKind;
  accountId: string | null;
  storeKey: string;
  status: OperationStatus;
  /** 应用级去重指纹：账号 + 目标 + 内容 hash；不依赖远端幂等头 */
  fingerprint: string;
  summary: string;
  steps: OperationStep[];
  /** 中断后是否可恢复；恢复必须由页面显式点击触发 */
  resumable: boolean;
  /**
   * 待处理项，仅存内部 ID 与恢复所需的上下文，不存邮箱。
   * 带上恢复上下文，是为了让「继续」不必依赖浏览器状态也能安全重放。
   */
  pending: {
    ids: string[];
    note: string;
    audienceId?: string;
    listId?: string;
    fields?: string[];
    currency?: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
};

// ---------- HTML 检查 ----------

export type LintIssue = { level: 'error' | 'warn'; rule: string; message: string };
export type LintResult = { ok: boolean; issues: LintIssue[] };

// ---------- 统一错误 ----------

export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'too_large'
  | 'unsupported'
  | 'writes_disabled'
  | 'rate_limited'
  | 'upstream'
  | 'unavailable';

export type ApiErrorBody = {
  code: ApiErrorCode;
  message: string;
  retryable: boolean;
  operationId?: string;
};