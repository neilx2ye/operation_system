import { getRepositories } from './repositories';
import { assertSafeId, newId, sha256 } from './ids';
import { fileOf, removeFile } from './storage';
import { MAX_HTML_BYTES, extractLocalAssetIds, lintEmailHtml, normalizeAssetMime } from './html';
import { badRequest, conflict, notFound, tooLarge, unsupported } from './http';
import { ASSET_MAX_BYTES, type Asset, type AudienceCounts, type AudienceExclusionReason, type AudienceFilterSummary, type AudienceSnapshot, type CreatePreparationInput, type CreateTemplateInput, type LintResult, type Operation, type OperationKind, type OperationStep, type Preparation, type StepStatus, type Template, type TemplateCategory, type TemplateVersion, type TemplateVersionMeta, type UpdateTemplateInput, type KlaviyoBinding, type KlaviyoIdentity, type KlaviyoListRecord, type KlaviyoMarketingStatus } from './types';
import { filterCustomers, describeFilters, TAG_NONE, type Filters } from '@/lib/customer-segmentation';
import { currentSource, customersByIds, listCustomers, type SourcedCustomer } from '@/lib/customer-source';
import { loadTags, tagGetter } from '@/lib/customer-tags';

const now = () => new Date().toISOString();
export const AUDIENCE_TTL_MS = 24 * 60 * 60 * 1000;

const repo = () => getRepositories();

export function identityKey(storeKey: string, accountId: string | null, customerId: string): string {
  return `${storeKey}|${accountId ?? ''}|${customerId}`;
}

// ---------- 模板 ----------

export function listTemplates(opts: { q?: string; categoryId?: string } = {}): { templates: Template[]; categories: TemplateCategory[] } {
  const r = repo();
  let templates = r.templates.listTemplates();
  if (opts.categoryId) templates = templates.filter((t) => t.categoryId === opts.categoryId);
  const q = (opts.q ?? '').trim().toLowerCase();
  if (q) templates = templates.filter((t) => `${t.name}\n${t.subject}\n${t.previewText}`.toLowerCase().includes(q));
  return { templates, categories: r.templates.listCategories() };
}

function mustTemplate(id: string): Template {
  assertSafeId(id, 'template');
  const t = repo().templates.getTemplate(id);
  if (!t) throw notFound('模板不存在');
  return t;
}

export type TemplateBundle = { template: Template; version: TemplateVersion; versions: TemplateVersionMeta[] };

export function getTemplateBundle(id: string): TemplateBundle {
  const template = mustTemplate(id);
  const r = repo();
  let version = r.templates.getVersion(template.currentVersionId);
  if (!version || version.templateId !== template.id) {
    // currentVersionId 指向丢失的版本：退回到最新版本并修好指针，而不是让页面空白
    const metas = r.templates.listVersionMetas(template.id);
    if (!metas.length) throw notFound('模板没有任何版本记录');
    const fallback = r.templates.getVersion(metas[metas.length - 1].id);
    if (!fallback) throw notFound('模板版本文件损坏');
    version = fallback;
    const repaired: Template = { ...template, currentVersionId: fallback.id, revision: template.revision + 1, updatedAt: now() };
    r.templates.putTemplate(repaired);
    return { template: repaired, version, versions: r.templates.listVersionMetas(template.id) };
  }
  return { template, version, versions: r.templates.listVersionMetas(template.id) };
}

export function metaOf(v: TemplateVersion): TemplateVersionMeta {
  const { html, ...rest } = v;
  return { ...rest, bytes: Buffer.byteLength(html) };
}

export function createTemplate(input: CreateTemplateInput): { template: Template; version: TemplateVersionMeta } {
  const name = (input.name ?? '').trim();
  if (!name) throw badRequest('模板名称不能为空');
  if (name.length > 120) throw badRequest('模板名称不能超过 120 个字符');
  const html = typeof input.html === 'string' && input.html.trim() ? input.html : STARTER_HTML;
  if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw tooLarge(`模板内容超过 ${Math.round(MAX_HTML_BYTES / 1024)} KB 上限`);

  const r = repo();
  if (input.categoryId) {
    assertSafeId(input.categoryId, 'category');
    if (!r.templates.listCategories().some((c) => c.id === input.categoryId)) throw badRequest('分类不存在');
  }
  const templateId = newId('template');
  const version: TemplateVersion = {
    id: newId('version'),
    templateId,
    html,
    hash: sha256(html),
    note: input.note ?? (input.origin === 'import' ? '导入 HTML' : '初始版本'),
    source: input.origin === 'import' ? 'import' : input.origin === 'klaviyo' ? 'klaviyo' : 'initial',
    fromVersionId: null,
    createdAt: now(),
  };
  const template: Template = {
    id: templateId,
    name,
    categoryId: input.categoryId ?? null,
    storeKey: input.storeKey ?? '',
    subject: input.subject ?? '',
    previewText: input.previewText ?? '',
    status: 'draft',
    currentVersionId: version.id,
    revision: 1,
    origin: input.origin ?? 'blank',
    remote: input.remote ?? null,
    createdAt: now(),
    updatedAt: now(),
  };
  r.templates.putVersion(version);
  r.templates.putTemplate(template);
  return { template, version: metaOf(version) };
}

export function updateTemplate(id: string, patch: UpdateTemplateInput): Template {
  return withLockSync(`tpl:${id}`, () => {
    const t = mustTemplate(id);
    if (patch.revision !== t.revision) throw conflict('模板已被其他操作修改，请刷新后重试', { currentRevision: t.revision });
    if (patch.name !== undefined && !patch.name.trim()) throw badRequest('模板名称不能为空');
    const r = repo();
    if (patch.categoryId) {
      assertSafeId(patch.categoryId, 'category');
      if (!r.templates.listCategories().some((c) => c.id === patch.categoryId)) throw badRequest('分类不存在');
    }
    const next: Template = {
      ...t,
      name: patch.name !== undefined ? patch.name.trim().slice(0, 120) : t.name,
      categoryId: patch.categoryId !== undefined ? (patch.categoryId ?? null) : t.categoryId,
      storeKey: patch.storeKey !== undefined ? patch.storeKey.trim().slice(0, 64) : t.storeKey,
      subject: patch.subject !== undefined ? patch.subject.slice(0, 200) : t.subject,
      previewText: patch.previewText !== undefined ? patch.previewText.slice(0, 200) : t.previewText,
      status: patch.status ?? t.status,
      revision: t.revision + 1,
      updatedAt: now(),
    };
    r.templates.putTemplate(next);
    return next;
  });
}

export function deleteTemplate(id: string): void {
  const t = mustTemplate(id);
  const r = repo();
  r.templates.deleteTemplate(t.id);
  // 版本文件随模板一起清理，避免孤儿版本被素材引用检查误判
  for (const m of r.templates.listVersionMetas(t.id)) removeVersionFile(m.id);
}

function removeVersionFile(versionId: string) {
  // 版本在文件适配器里是独立文件；memory 适配器没有对应文件，删除自然为无操作
  removeFile(fileOf('versions', versionId));
}

export function duplicateTemplate(id: string, name?: string): { template: Template; version: TemplateVersionMeta } {
  const src = mustTemplate(id);
  const r = repo();
  const source = r.templates.getVersion(src.currentVersionId);
  if (!source) throw notFound('模板当前版本丢失，无法复制');
  const copy = createTemplate({
    name: (name ?? `${src.name} (副本)`).trim().slice(0, 120),
    categoryId: src.categoryId,
    storeKey: src.storeKey,
    subject: src.subject,
    previewText: src.previewText,
    html: source.html,
    origin: 'blank',
    note: `复制自 ${src.name}`,
  });
  // 远端绑定不随复制带过来：副本默认只存在于本地，避免误覆盖远端模板
  return copy;
}

export function listVersions(templateId: string): TemplateVersionMeta[] {
  mustTemplate(templateId);
  return repo().templates.listVersionMetas(templateId);
}

export function getVersion(templateId: string, versionId: string): TemplateVersion {
  mustTemplate(templateId);
  assertSafeId(versionId, 'version');
  const v = repo().templates.getVersion(versionId);
  if (!v || v.templateId !== templateId) throw notFound('版本不存在');
  return v;
}

export function saveVersion(
  templateId: string,
  input: { html: string; note?: string; expectedRevision?: number; source?: TemplateVersion['source']; fromVersionId?: string | null },
): { template: Template; version: TemplateVersionMeta } {
  if (typeof input.html !== 'string') throw badRequest('缺少 html');
  if (Buffer.byteLength(input.html) > MAX_HTML_BYTES) throw tooLarge(`模板内容超过 ${Math.round(MAX_HTML_BYTES / 1024)} KB 上限`);
  return withLockSync(`tpl:${templateId}`, () => {
    const t = mustTemplate(templateId);
    if (input.expectedRevision !== undefined && input.expectedRevision !== t.revision) {
      throw conflict('模板已被其他操作修改，请刷新后重试', { currentRevision: t.revision });
    }
    const r = repo();
    const version: TemplateVersion = {
      id: newId('version'),
      templateId: t.id,
      html: input.html,
      hash: sha256(input.html),
      note: (input.note ?? '').slice(0, 200),
      source: input.source ?? 'manual',
      fromVersionId: input.fromVersionId ?? null,
      createdAt: now(),
    };
    r.templates.putVersion(version);
    const next: Template = { ...t, currentVersionId: version.id, revision: t.revision + 1, updatedAt: now() };
    r.templates.putTemplate(next);
    return { template: next, version: metaOf(version) };
  });
}

/** 回滚不改写旧版本，而是把旧内容复制成一个新版本 */
export function rollbackVersion(templateId: string, versionId: string, expectedRevision?: number): { template: Template; version: TemplateVersionMeta } {
  const v = getVersion(templateId, versionId);
  return saveVersion(templateId, {
    html: v.html,
    note: `回滚自版本 ${v.id}`,
    expectedRevision,
    source: 'rollback',
    fromVersionId: v.id,
  });
}

export function lintTemplate(templateId: string, html?: string): LintResult {
  const bundle = html === undefined ? getTemplateBundle(templateId) : null;
  const source = html ?? bundle!.version.html;
  if (Buffer.byteLength(source) > MAX_HTML_BYTES) throw tooLarge('模板内容过大');
  return lintEmailHtml(source, { knownAssetIds: repo().assets.listAssets().map((a) => a.id) });
}

// ---------- 分类 ----------

export function listCategories(): TemplateCategory[] {
  return repo().templates.listCategories();
}

export function upsertCategory(name: string, id?: string): TemplateCategory {
  const clean = name.trim().slice(0, 60);
  if (!clean) throw badRequest('分类名称不能为空');
  const r = repo();
  const existing = id ? r.templates.listCategories().find((c) => c.id === id) : r.templates.listCategories().find((c) => c.name === clean);
  if (existing && id) {
    const next = { ...existing, name: clean };
    r.templates.putCategory(next);
    return next;
  }
  if (existing) return existing;
  const list = r.templates.listCategories();
  const cat: TemplateCategory = { id: id && /^cat_/.test(id) ? id : newId('category'), name: clean, order: list.length, createdAt: now() };
  r.templates.putCategory(cat);
  return cat;
}

export function deleteCategory(id: string): void {
  assertSafeId(id, 'category');
  const r = repo();
  const cat = r.templates.listCategories().find((c) => c.id === id);
  if (!cat) throw notFound('分类不存在');
  const used = r.templates.listTemplates().filter((t) => t.categoryId === id).length;
  if (used > 0) throw conflict(`该分类下还有 ${used} 个模板，请先移动或删除这些模板`);
  r.templates.deleteCategory(id);
}

// ---------- 素材 ----------

export function listAssets(): Asset[] {
  return repo().assets.listAssets();
}

export function getAsset(id: string): Asset {
  assertSafeId(id, 'asset');
  const a = repo().assets.getAsset(id);
  if (!a) throw notFound('素材不存在');
  return a;
}

export function readAssetBody(id: string): { asset: Asset; body: Buffer } {
  const asset = getAsset(id);
  const body = repo().assets.readAssetBody(id);
  if (!body) throw notFound('素材文件丢失');
  return { asset, body };
}

function magicMatches(mime: string, body: Buffer): boolean {
  if (body.length < 12) return false;
  if (mime === 'image/jpeg') return body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
  if (mime === 'image/png') return body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47;
  if (mime === 'image/gif') return body.slice(0, 4).toString('ascii') === 'GIF8';
  return false;
}

function safeFilename(name: string): string {
  return (name || 'image')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\\/]/g, '_')
    .trim()
    .slice(0, 200);
}

export function createAsset(input: { filename: string; mime: string; body: Buffer }): { asset: Asset; deduplicated: boolean } {
  const mime = normalizeAssetMime(input.mime);
  if (!mime) throw unsupported('仅支持 JPEG / PNG / GIF 图片；请重新选择文件');
  if (input.body.length === 0) throw badRequest('文件内容为空');
  if (input.body.length > ASSET_MAX_BYTES) throw tooLarge(`图片超过 ${Math.round(ASSET_MAX_BYTES / 1024 / 1024)} MB 上限`);
  if (!magicMatches(mime, input.body)) throw unsupported('文件内容与图片格式不符，请重新选择文件');

  const r = repo();
  const hash = sha256(input.body);
  const dup = r.assets.listAssets().find((a) => a.hash === hash && a.mime === mime);
  if (dup) return { asset: dup, deduplicated: true };

  const id = newId('asset');
  const asset: Asset = {
    id,
    filename: safeFilename(input.filename),
    mime,
    size: input.body.length,
    hash,
    path: `/api/edm/assets/${id}`,
    uploaded: null,
    createdAt: now(),
  };
  r.assets.writeAssetBody(id, input.body);
  r.assets.putAsset(asset);
  return { asset, deduplicated: false };
}

export type AssetReference = { templateId: string; templateName: string; versionId: string };

export function assetReferences(assetId: string): AssetReference[] {
  assertSafeId(assetId, 'asset');
  const r = repo();
  const out: AssetReference[] = [];
  for (const t of r.templates.listTemplates()) {
    for (const m of r.templates.listVersionMetas(t.id)) {
      const v = r.templates.getVersion(m.id);
      if (!v) continue;
      if (extractLocalAssetIds(v.html).includes(assetId)) out.push({ templateId: t.id, templateName: t.name, versionId: v.id });
    }
  }
  return out;
}

export function deleteAsset(id: string): void {
  getAsset(id);
  const refs = assetReferences(id);
  if (refs.length) {
    throw conflict(`该素材仍被 ${refs.length} 个模板版本引用，删除前请先在模板里替换或移除`, { references: refs.slice(0, 20) });
  }
  repo().assets.deleteAsset(id);
}

// ---------- 受众 ----------

export type AudienceRequest = {
  mode: 'ids' | 'filters';
  ids?: unknown;
  filters?: Filters;
  tag?: string | null;
  query?: string;
};

/**
 * 把浏览器传来的对象收敛成 AudienceRequest。
 * 放在服务层而不是路由里，避免其他路由去 import 一个 route 文件。
 */
export function parseAudienceRequest(b: Record<string, unknown>): AudienceRequest {
  return {
    mode: b.mode === 'ids' ? 'ids' : 'filters',
    ids: Array.isArray(b.ids) ? b.ids : [],
    filters: b.filters && typeof b.filters === 'object' ? (b.filters as Filters) : {},
    tag: typeof b.tag === 'string' ? b.tag : null,
    query: typeof b.query === 'string' ? b.query : '',
  };
}

export type AudiencePreview = {
  storeKey: string;
  dataSource: 'mock' | 'shopify';
  sourceRevision: string;
  syncedAt: string | null;
  mode: 'ids' | 'filters';
  scopeLabel: string;
  filters: string[];
  total: number;
  validEmail: number;
  duplicateEmail: number;
  mailable: number;
  pending: number;
  excluded: { reason: AudienceExclusionReason; count: number }[];
  mock: boolean;
  /** 命中集合的指纹：让用户在确认前看出范围是否变化 */
  candidateHash: string;
  expiresAt: string;
};

type Computed = AudiencePreview & { candidates: SourcedCustomer[]; customerIds: string[]; filterSummary: AudienceFilterSummary };

const EXCLUSION_LABELS: Record<AudienceExclusionReason, string> = {
  not_found: '在当前数据源中找不到该客户 ID',
  outside_source: '不属于当前数据源/店铺',
  no_email: '没有邮箱',
  placeholder_email: '异常占位邮箱',
  invalid_email: '邮箱格式不合法',
  duplicate_email: '与其他客户邮箱重复',
  mock_source: '演示数据(Mock)不可用于真实写入',
};

export function exclusionLabel(reason: AudienceExclusionReason): string {
  return EXCLUSION_LABELS[reason] ?? reason;
}

/** 服务端重新读取数据源并计算筛选；不接受浏览器声称的 LTV/标签/订阅状态 */
export function computeAudience(req: AudienceRequest): Computed {
  const src = currentSource();
  if (req.mode !== 'ids' && req.mode !== 'filters') throw badRequest('mode 必须是 ids 或 filters');

  const filters: Filters = (req.filters ?? {}) as Filters;
  const tag = typeof req.tag === 'string' ? req.tag : null;
  const query = typeof req.query === 'string' ? req.query : '';

  let rows: SourcedCustomer[];
  const excluded = new Map<AudienceExclusionReason, number>();
  const bump = (r: AudienceExclusionReason, n = 1) => excluded.set(r, (excluded.get(r) ?? 0) + n);

  if (req.mode === 'filters') {
    if (tag && tag !== TAG_NONE) {
      const known = new Set(Object.values(loadTags()).flat());
      if (!known.has(tag)) throw badRequest('标签不存在');
    }
    const tags = loadTags();
    rows = filterCustomers(listCustomers(), filters, { tag, tagOf: tagGetter(tags), query });
  } else {
    if (!Array.isArray(req.ids)) throw badRequest('ids 必须是数组');
    if (req.ids.length > 20000) throw badRequest('单次选择的客户数量过多');
    const ids = [...new Set(req.ids.map((v) => String(v)))].filter((v) => /^[A-Za-z0-9_-]{1,64}$/.test(v));
    // 勾选同样要逐个验证 ID 仍属于当前数据源
    const found = customersByIds(ids);
    const missing = ids.length - found.filter(Boolean).length;
    if (missing > 0) bump('not_found', missing);
    rows = found.filter((r): r is SourcedCustomer => r !== null);
  }

  const total = rows.length;

  const seen = new Map<string, string>();
  const candidates: SourcedCustomer[] = [];
  let duplicateEmail = 0;
  for (const r of rows) {
    if (r.emailStatus === 'empty') {
      bump('no_email');
      continue;
    }
    if (r.emailStatus === 'placeholder') {
      bump('placeholder_email');
      continue;
    }
    if (r.emailStatus === 'invalid' || !r.emailKey) {
      bump('invalid_email');
      continue;
    }
    if (seen.has(r.emailKey)) {
      duplicateEmail++;
      bump('duplicate_email');
      continue;
    }
    seen.set(r.emailKey, r.id);
    candidates.push(r);
  }

  const integrations = repo().integrations.read().klaviyo;
  const accountId = integrations.binding.accountId;
  let mailable = 0;
  let pending = 0;
  for (const c of candidates) {
    const status = integrations.marketing[identityKey(src.storeKey, accountId, c.id)];
    if (isMailable(status)) mailable++;
    else pending++;
  }

  const mock = src.dataSource === 'mock';
  if (mock) {
    // Mock 数据只能用于模拟：真实写入集合恒为空
    if (candidates.length) bump('mock_source', candidates.length);
    pending = candidates.length;
    mailable = 0;
  }

  const scopeLabel = req.mode === 'ids' ? `勾选 ${total} 位客户` : '当前筛选结果';
  const filterList = req.mode === 'filters' ? describeFilters(filters, tag) : [];

  const filterSummary: AudienceFilterSummary = {};
  (['segment', 'source', 'country', 'cohort', 'abandon'] as const).forEach((k) => {
    if (filters[k]) filterSummary[k] = filters[k];
  });
  if (tag) filterSummary.tag = tag;
  if (query.trim()) filterSummary.queryHash = sha256(query.trim()).slice(0, 16);

  const candidateHash = sha256([src.revision, ...candidates.map((c) => c.id)].join('|')).slice(0, 16);

  return {
    storeKey: src.storeKey,
    dataSource: src.dataSource,
    sourceRevision: src.revision,
    syncedAt: src.syncedAt,
    mode: req.mode,
    scopeLabel,
    filters: filterList,
    total,
    validEmail: candidates.length,
    duplicateEmail,
    mailable,
    pending,
    excluded: [...excluded.entries()].map(([reason, count]) => ({ reason, count })),
    mock,
    candidateHash,
    expiresAt: new Date(Date.now() + AUDIENCE_TTL_MS).toISOString(),
    candidates,
    customerIds: rows.map((r) => r.id),
    filterSummary,
  };
}

export function isMailable(status: KlaviyoMarketingStatus | undefined): boolean {
  if (!status) return false;
  return status.canReceiveEmail === true && status.subscribed === true && status.globalSuppressed === false && status.listSuppressed === false;
}

export function publicPreview(c: Computed): AudiencePreview {
  const { candidates, customerIds, filterSummary, ...rest } = c;
  return rest;
}

/** 过期很久的快照直接清理，避免目录无限增长（保留 7 天便于复盘） */
const AUDIENCE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function pruneAudiences(): number {
  const cutoff = Date.now() - AUDIENCE_RETENTION_MS;
  let removed = 0;
  for (const a of repo().audiences.listAudiences()) {
    if (Date.parse(a.expiresAt) < cutoff) {
      removeFile(fileOf('audiences', a.id));
      removed++;
    }
  }
  return removed;
}

export function createAudience(req: AudienceRequest): AudienceSnapshot {
  pruneAudiences();
  const c = computeAudience(req);
  const counts: AudienceCounts = {
    total: c.total,
    validEmail: c.validEmail,
    duplicateEmail: c.duplicateEmail,
    mailable: c.mailable,
    pending: c.pending,
  };
  const snapshot: AudienceSnapshot = {
    id: newId('audience'),
    storeKey: c.storeKey,
    dataSource: c.dataSource,
    sourceRevision: c.sourceRevision,
    sourceSyncedAt: c.syncedAt,
    mode: c.mode,
    filters: c.filterSummary,
    customerIds: c.customerIds,
    counts,
    excluded: c.excluded,
    createdAt: now(),
    expiresAt: c.expiresAt,
    invalidatedAt: null,
    invalidReason: null,
  };
  repo().audiences.putAudience(snapshot);
  return snapshot;
}

export function getAudience(id: string): AudienceSnapshot {
  assertSafeId(id, 'audience');
  const a = repo().audiences.getAudience(id);
  if (!a) throw notFound('受众快照不存在或已过期清理');
  return a;
}

/** 列表只返回快照本身，不重新计算，也不包含邮箱等 PII */
export function listAudiencesPublic(): AudienceSnapshot[] {
  return repo().audiences.listAudiences();
}

export type AudienceValidity = { audience: AudienceSnapshot; valid: boolean; invalidReason: string | null };

/** 数据源、店铺或内容指纹变化时快照立即失效，不能拿昨天的选择去写今天的客户 */
export function loadAudience(id: string): AudienceValidity {
  const audience = getAudience(id);
  const src = currentSource();
  let invalidReason: string | null = null;
  if (audience.invalidatedAt) invalidReason = audience.invalidReason ?? '快照已被标记失效';
  else if (Date.parse(audience.expiresAt) < Date.now()) invalidReason = '快照已超过 24 小时有效期';
  else if (src.revision !== audience.sourceRevision) invalidReason = `数据源内容已变化（快照 ${audience.sourceRevision.slice(0, 8)} → 当前 ${src.revision.slice(0, 8)}）`;
  else if (src.storeKey !== audience.storeKey) invalidReason = '店铺绑定已变化';
  return { audience, valid: invalidReason === null, invalidReason };
}

export function invalidateAudience(id: string, reason: string): AudienceSnapshot {
  return withLockSync(`aud:${id}`, () => {
    const a = getAudience(id);
    const next: AudienceSnapshot = { ...a, invalidatedAt: now(), invalidReason: reason.slice(0, 200) };
    repo().audiences.putAudience(next);
    return next;
  });
}

// ---------- 邮件准备记录 ----------

export function listPreparations(templateId?: string): Preparation[] {
  const list = repo().preparations.listPreparations();
  return templateId ? list.filter((p) => p.templateId === templateId) : list;
}

export function getPreparation(id: string): Preparation {
  assertSafeId(id, 'preparation');
  const p = repo().preparations.getPreparation(id);
  if (!p) throw notFound('邮件准备记录不存在');
  return p;
}

export function createPreparation(input: CreatePreparationInput): Preparation {
  const template = mustTemplate(input.templateId);
  const bundle = getTemplateBundle(template.id);
  const versionId = input.versionId ?? bundle.version.id;
  const version = getVersion(template.id, versionId);
  const audience = getAudience(input.audienceId);
  const prep: Preparation = {
    id: newId('preparation'),
    templateId: template.id,
    versionId: version.id,
    audienceId: audience.id,
    subject: (input.subject ?? template.subject).slice(0, 200),
    previewText: (input.previewText ?? template.previewText).slice(0, 200),
    accountId: input.accountId ?? repo().integrations.read().klaviyo.binding.accountId,
    createdAt: now(),
    updatedAt: now(),
  };
  repo().preparations.putPreparation(prep);
  return prep;
}

// ---------- 执行记录 ----------

export function createOperation(input: {
  kind: OperationKind;
  accountId: string | null;
  storeKey: string;
  fingerprint: string;
  summary: string;
  steps?: OperationStep[];
}): Operation {
  const op: Operation = {
    id: newId('operation'),
    kind: input.kind,
    accountId: input.accountId,
    storeKey: input.storeKey,
    status: 'pending',
    fingerprint: input.fingerprint,
    summary: input.summary,
    steps: input.steps ?? [],
    resumable: false,
    pending: null,
    createdAt: now(),
    updatedAt: now(),
  };
  repo().operations.putOperation(op);
  return op;
}

export function getOperation(id: string): Operation {
  assertSafeId(id, 'operation');
  const op = repo().operations.getOperation(id);
  if (!op) throw notFound('执行记录不存在');
  return op;
}

export function listOperations(limit = 50): Operation[] {
  return repo().operations.listOperations().slice(0, limit);
}

export function appendStep(id: string, step: OperationStep): Operation {
  return withLockSync(`op:${id}`, () => {
    const op = getOperation(id);
    const next: Operation = { ...op, steps: [...op.steps, step], updatedAt: now() };
    repo().operations.putOperation(next);
    return next;
  });
}

export function finishOperation(
  id: string,
  status: Operation['status'],
  patch: Partial<Pick<Operation, 'resumable' | 'pending' | 'summary'>> = {},
): Operation {
  return withLockSync(`op:${id}`, () => {
    const op = getOperation(id);
    const next: Operation = { ...op, status, ...patch, updatedAt: now() };
    repo().operations.putOperation(next);
    return next;
  });
}

export function step(name: string, status: StepStatus, count: number | null, detail: string): OperationStep {
  return { name, status, count, detail: detail.slice(0, 400), at: now() };
}

export function getBinding(): KlaviyoBinding {
  return repo().integrations.read().klaviyo.binding;
}

/** 只读的映射/缓存视图，供只读接口使用 */
export function getIntegrationState() {
  const k = repo().integrations.read().klaviyo;
  return { binding: k.binding, identities: k.identities, remoteTemplates: k.remoteTemplates, lists: k.lists, marketing: k.marketing };
}

export function updateBinding(patch: Partial<KlaviyoBinding>): KlaviyoBinding {
  return withLockSync('integrations', () => {
    const file = repo().integrations.read();
    file.klaviyo.binding = { ...file.klaviyo.binding, ...patch };
    repo().integrations.write(file);
    return file.klaviyo.binding;
  });
}

/** 账号或店铺变化时，旧的远端映射与状态缓存不再可信 */
export function resetMappings(reason: string): void {
  withLockSync('integrations', () => {
    const file = repo().integrations.read();
    file.klaviyo.identities = {};
    file.klaviyo.marketing = {};
    file.klaviyo.remoteTemplates = {};
    repo().integrations.write(file);
    void reason;
  });
}

export function cacheLists(lists: KlaviyoListRecord[]): void {
  withLockSync('integrations', () => {
    const file = repo().integrations.read();
    file.klaviyo.lists = lists;
    repo().integrations.write(file);
  });
}

export function cacheIdentities(
  entries: { key: string; identity: KlaviyoIdentity; status?: KlaviyoMarketingStatus }[],
): void {
  withLockSync('integrations', () => {
    const file = repo().integrations.read();
    for (const e of entries) {
      file.klaviyo.identities[e.key] = e.identity;
      // 只在真的查到状态时覆盖：资料写入途中不能把已知的订阅状态抹成未知
      if (e.status) file.klaviyo.marketing[e.key] = e.status;
    }
    repo().integrations.write(file);
  });
}

export function recordAssetUpload(assetId: string, url: string, accountId: string): Asset {
  return withLockSync(`asset:${assetId}`, () => {
    const a = getAsset(assetId);
    const next: Asset = { ...a, uploaded: { accountId, url, uploadedAt: now() } };
    repo().assets.putAsset(next);
    return next;
  });
}

export function cacheRemoteTemplate(templateId: string, record: import('./types').RemoteTemplateRecord): void {
  withLockSync('integrations', () => {
    const file = repo().integrations.read();
    file.klaviyo.remoteTemplates[templateId] = record;
    repo().integrations.write(file);
  });
}

/** 记录模板与远端模板的绑定（推送成功后） */
export function bindRemoteTemplate(templateId: string, link: import('./types').RemoteTemplateLink): Template {
  return withLockSync(`tpl:${templateId}`, () => {
    const t = mustTemplate(templateId);
    const next: Template = { ...t, remote: link, revision: t.revision + 1, updatedAt: now() };
    repo().templates.putTemplate(next);
    return next;
  });
}

// ---------- 读改写原子性 ----------

/**
 * 模板、素材、受众、执行记录的读改写全部是同步 fs 调用，中间没有 await，
 * 因此 Node 单线程下整段天然不可被打断，不需要额外加锁。
 * 保留这个包装是为了标记「这段必须保持同步」：一旦引入 await，
 * 就必须改用 storage.withLock 的异步队列，否则并发写会互相覆盖。
 */
function withLockSync<T>(_key: string, fn: () => T): T {
  return fn();
}

// ---------- 起始模板 ----------

/** 新模板的起始 HTML：表格布局、内联样式、带退订入口，保证首屏检查就能通过 */
export const STARTER_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{ subject }}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:8px;">
<tr><td style="padding:32px 32px 8px;font-family:Arial,Helvetica,sans-serif;font-size:22px;color:#111111;">
你好 {{ first_name|default:"there" }}，
</td></tr>
<tr><td style="padding:8px 32px 24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#444444;">
这里是正文。请在右侧预览里点选元素进行编辑，或直接修改左侧源码。
</td></tr>
<tr><td style="padding:0 32px 32px;">
<a href="{{ url }}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-family:Arial,Helvetica,sans-serif;font-size:15px;">立即查看</a>
</td></tr>
<tr><td style="padding:16px 32px 32px;border-top:1px solid #eeeeee;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#888888;">
你收到这封邮件是因为你订阅了我们的更新。
<a href="{{ unsubscribe_link }}" style="color:#888888;text-decoration:underline;">退订</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;