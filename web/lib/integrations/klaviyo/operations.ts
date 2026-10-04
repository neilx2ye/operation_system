import { badRequest, conflict, nowIso } from '@/lib/edm/http';
import { sha256 } from '@/lib/edm/ids';
import { extractLocalAssetIds, lintEmailHtml, replaceLocalAssetIds } from '@/lib/edm/html';
import {
  appendStep,
  bindRemoteTemplate,
  cacheIdentities,
  cacheRemoteTemplate,
  createOperation,
  finishOperation,
  getIntegrationState,
  getOperation,
  getTemplateBundle,
  getVersion,
  identityKey,
  isMailable,
  listAssets,
  loadAudience,
  readAssetBody,
  recordAssetUpload,
  step,
} from '@/lib/edm/service';
import { customersByIds, type SourcedCustomer } from '@/lib/customer-source';
import { segmentOf } from '@/lib/customer-segmentation';
import { loadTags } from '@/lib/customer-tags';
import type { AudienceSnapshot, KlaviyoMarketingStatus, Operation } from '@/lib/edm/types';
import { outcomeOf } from './client';
import { confirmList, confirmProfiles, confirmTemplate, requireWrite, type WriteContext } from './write-gate';
import { assertHtmlEditable, createRemoteTemplate, getRemoteTemplate, updateRemoteTemplate } from './templates';
import { lookupProfilesByEmail, upsertProfile } from './profiles';
import { addProfilesToList, fetchListMemberIds } from './lists';
import { uploadImage } from './images';

// 三个独立动作：推送模板 / 同步客户资料 / 加入名单。
// 它们各自确认、各自记录，绝不打包成一个按钮完成。
// 本期不调用订阅、重新订阅或取消抑制接口，也不创建 Campaign / Flow。

const SYNC_BUDGET_MS = 45_000;
const LIST_BATCH = 100;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

// ---------- 受众解析 ----------

export type Candidate = { customer: SourcedCustomer; emailKey: string };

/** 按快照里的客户 ID 在服务端重新解析真实客户；Mock、无邮箱、异常邮箱、重复邮箱一律剔除 */
export async function resolveCandidates(audienceId: string): Promise<{ audience: AudienceSnapshot; candidates: Candidate[] }> {
  const { audience, valid, invalidReason } = await loadAudience(audienceId);
  if (!valid) throw conflict(`受众快照已失效：${invalidReason}。请在用户页面重新选择并确认后再试`, { invalidReason });
  const rows = await customersByIds(audience.customerIds);
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const r of rows) {
    if (!r || r.emailStatus !== 'valid' || !r.emailKey) continue;
    if (seen.has(r.emailKey)) continue;
    seen.add(r.emailKey);
    candidates.push({ customer: r, emailKey: r.emailKey });
  }
  return { audience, candidates };
}

export function candidateHashOf(sourceRevision: string, candidates: Candidate[]): string {
  return sha256([sourceRevision, ...candidates.map((c) => c.customer.id)].join('|')).slice(0, 16);
}

// ---------- 可写字段白名单 ----------

export const ASSIGNABLE_FIELDS = ['ops_customer_ref', 'ops_segment', 'ops_tags', 'ops_orders', 'ops_ltv', 'ops_currency', 'ops_last_order_at'] as const;
export type AssignableField = (typeof ASSIGNABLE_FIELDS)[number];

export function sanitizeFields(input: unknown): AssignableField[] {
  if (!Array.isArray(input)) return [];
  const allowed = new Set<string>(ASSIGNABLE_FIELDS);
  return [...new Set(input.map((v) => String(v)).filter((v) => allowed.has(v)))] as AssignableField[];
}

/**
 * 只写白名单里的运营字段，避免覆盖 Klaviyo / Shopify 已维护的原生字段。
 * 缺失的字段直接省略，不用 null 去清空远端。
 * 货币单位无法核实时不推送裸 LTV 金额。
 */
export async function buildProfileProperties(customer: SourcedCustomer, fields: AssignableField[], currency: string | null): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const tags = await loadTags();
  for (const f of fields) {
    switch (f) {
      case 'ops_customer_ref':
        out[f] = customer.id;
        break;
      case 'ops_segment':
        out[f] = segmentOf(customer);
        break;
      case 'ops_tags': {
        const t = tags[customer.id];
        if (t && t.length) out[f] = t;
        break;
      }
      case 'ops_orders':
        out[f] = customer.orders;
        break;
      case 'ops_ltv':
        if (currency) out[f] = customer.ltv;
        break;
      case 'ops_currency':
        if (currency) out[f] = currency;
        break;
      case 'ops_last_order_at':
        if (customer.lastOrder) out[f] = customer.lastOrder;
        break;
      default:
        break;
    }
  }
  return out;
}

// ---------- 预检 ----------

export type PreflightKind = 'template' | 'profile' | 'list';

export type PreflightRequest = {
  kind: PreflightKind;
  templateId?: string;
  versionId?: string;
  audienceId?: string;
  listId?: string;
  fields?: unknown;
  currency?: string | null;
  onConflict?: 'fail' | 'new';
};

export type PreflightResult = {
  ok: boolean;
  blockers: string[];
  warnings: string[];
  summary: Record<string, unknown>;
  confirm: string;
};

export async function preflight(
  ctx: { cfg: import('./config').KlaviyoConfig | null; binding: import('@/lib/edm/types').KlaviyoBinding; storeKey: string },
  input: PreflightRequest,
): Promise<PreflightResult> {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (input.kind === 'template') {
    if (!input.templateId) throw badRequest('缺少 templateId');
    const bundle = await getTemplateBundle(input.templateId);
    const version = input.versionId ? await getVersion(input.templateId, input.versionId) : bundle.version;
    const summary: Record<string, unknown> = {
      account: ctx.binding.accountId,
      accountLabel: ctx.binding.accountLabel,
      storeKey: ctx.storeKey,
      templateName: bundle.template.name,
      versionId: version.id,
      versionHash: version.hash,
    };

    const localIds = extractLocalAssetIds(version.html);
    const assets = new Map((await listAssets()).map((a) => [a.id, a]));
    const missing = localIds.filter((id) => !assets.has(id));
    if (missing.length) blockers.push(`模板引用了不存在的本地素材：${missing.join(', ')}`);

    const unresolved = localIds.filter((id) => {
      const a = assets.get(id);
      return a && !(a.uploaded && a.uploaded.accountId === ctx.binding.accountId);
    });
    summary.assets = localIds.length;
    summary.assetsPendingUpload = unresolved.length;
    if (unresolved.length) warnings.push(`有 ${unresolved.length} 张本地素材将在推送时上传到 Klaviyo，并替换为远端地址`);

    const previewHtml = replaceLocalAssetIds(
      version.html,
      Object.fromEntries(localIds.map((id) => [id, assets.get(id)?.uploaded?.url ?? '/api/edm/assets/' + id])),
    );
    const lint = lintEmailHtml(previewHtml, { knownAssetIds: [...assets.keys()] });
    summary.lintErrors = lint.issues.filter((i) => i.level === 'error').length;
    for (const issue of lint.issues.filter((i) => i.level === 'error')) blockers.push(`发布前检查未通过（${issue.rule}）：${issue.message}`);

    const linked = bundle.template.remote && bundle.template.remote.accountId === ctx.binding.accountId ? bundle.template.remote : null;
    summary.remoteId = linked?.remoteId ?? null;
    if (!ctx.cfg) {
      // 没有私钥也要能跑预检：把「缺私钥」当成一条阻断原因报出来，
      // 而不是让整个预检接口直接失败。
      blockers.push('未配置 KLAVIYO_PRIVATE_API_KEY，无法核对远端模板是否被他人修改');
    } else if (linked) {
      try {
        const remote = await getRemoteTemplate(linked.remoteId, ctx.cfg);
        summary.remoteEditorType = remote.editorType;
        summary.remoteUpdated = remote.updated;
        if (remote.editorType !== 'CODE' && remote.editorType !== 'USER_DRAGGABLE') {
          blockers.push(`远端模板类型是 ${remote.editorType}，不能按 HTML 原地覆盖，请改为另存为新模板`);
        }
        if (linked.remoteFingerprint && remote.updated && remote.updated !== linked.remoteFingerprint) {
          if (input.onConflict === 'new') warnings.push('远端模板已被其他人修改，按你的选择将创建了一个新的远端模板而不是覆盖');
          else blockers.push('远端模板已被其他人修改，已阻止覆盖；请选择「另存为新模板」或先核对远端内容');
        }
      } catch (e) {
        blockers.push(`无法读取远端模板：${messageOf(e)}`);
      }
    } else {
      warnings.push('将创建一个新的 Klaviyo 模板（CODE 类型）');
    }
    return { ok: blockers.length === 0, blockers, warnings, summary, confirm: confirmTemplate(bundle.template.id, version.hash) };
  }

  if (input.kind === 'profile' || input.kind === 'list') {
    if (!input.audienceId) throw badRequest('缺少 audienceId');
    const { audience, candidates } = await resolveCandidates(input.audienceId);
    const hash = candidateHashOf(audience.sourceRevision, candidates);
    const fields = sanitizeFields(input.fields);
    const currency = (input.currency ?? '').trim().toUpperCase() || null;

    const summary: Record<string, unknown> = {
      account: ctx.binding.accountId,
      accountLabel: ctx.binding.accountLabel,
      storeKey: ctx.storeKey,
      audienceId: audience.id,
      scopeLabel: audience.mode === 'ids' ? `勾选 ${audience.counts.total} 位客户` : '当前筛选结果',
      total: audience.counts.total,
      validEmail: candidates.length,
      duplicateEmail: audience.counts.duplicateEmail,
      source: audience.dataSource,
      sourceRevision: audience.sourceRevision,
    };

    if (audience.dataSource === 'mock') blockers.push('当前受众来自演示数据(Mock)，不能写入真实 Klaviyo 账号');

    if (input.kind === 'profile') {
      summary.fields = fields;
      summary.currency = currency;
      if (!fields.length) blockers.push('请至少选择一个要同步的字段');
      if (fields.includes('ops_ltv') && !currency) blockers.push('推送 ops_ltv 前必须确认货币单位（无法核实的金额不上传）');
      if (!candidates.length) blockers.push('该受众没有可用的有效邮箱');

      const known = await getIntegrationState();
      const mapped = candidates.filter((c) => known.identities[identityKey(audience.storeKey, ctx.binding.accountId, c.customer.id)]).length;
      summary.alreadyMapped = mapped;
      summary.willCreateOrUpdate = candidates.length;
      summary.subscriptionNote = '资料同步不附带订阅操作，也不会把客户表述为「已同意营销」';
      return { ok: blockers.length === 0, blockers, warnings, summary, confirm: confirmProfiles(audience.id, hash) };
    }

    if (!input.listId) throw badRequest('缺少 listId');
    const cachedList = (await getIntegrationState()).lists.find((l) => l.id === input.listId);
    summary.listId = input.listId;
    summary.listName = cachedList?.name ?? null;
    if (!cachedList) warnings.push('目标名单不在本地缓存里，请先在设置页刷新名单列表以确认名称');
    summary.willSubmit = audience.counts.mailable;
    summary.excludedByRule = candidates.length - audience.counts.mailable;
    warnings.push('加入名单前会重新刷新一次订阅/抑制状态；只有取得明确订阅状态且不受抑制影响的客户才会提交');
    warnings.push('只增加成员，不删除远端已有成员；资料属性或成员变化可能触发 Klaviyo 已有的分群与自动化，请先确认影响');
    if (!candidates.length) blockers.push('该受众没有可用的有效邮箱');
    else if (audience.counts.mailable === 0) blockers.push('按当前缓存，没有符合本期订阅规则的客户；请先刷新营销状态');
    return { ok: blockers.length === 0, blockers, warnings, summary, confirm: confirmList(input.listId, audience.id, hash) };
  }

  throw badRequest('不支持的预检类型');
}

// ---------- 推送模板 ----------

export type TemplateSyncInput = { templateId: string; versionId?: string; onConflict?: 'fail' | 'new'; confirm: string };

export async function runTemplateSync(ctx: WriteContext, input: TemplateSyncInput): Promise<Operation> {
  const bundle = await getTemplateBundle(input.templateId);
  const version = input.versionId ? await getVersion(input.templateId, input.versionId) : bundle.version;
  if (input.confirm !== confirmTemplate(bundle.template.id, version.hash)) {
    throw badRequest('确认信息与当前模板版本不一致，请重新确认后再推送', { expected: confirmTemplate(bundle.template.id, version.hash) });
  }

  const op = await createOperation({
    kind: 'template_sync',
    accountId: ctx.binding.accountId,
    storeKey: ctx.storeKey,
    fingerprint: sha256(`${ctx.binding.accountId ?? ''}|template|${bundle.template.id}|${version.hash}`),
    summary: `推送模板「${bundle.template.name}」版本 ${version.id.slice(0, 12)}`,
  });

  try {
    // 1) 冻结发布快照：本地素材上传后替换成远端地址
    const assets = new Map((await listAssets()).map((a) => [a.id, a]));
    const mapping: Record<string, string> = {};
    let uploadedCount = 0;
    for (const id of extractLocalAssetIds(version.html)) {
      const asset = assets.get(id);
      if (!asset) throw badRequest(`模板引用了不存在的素材 ${id}`);
      if (asset.uploaded && asset.uploaded.accountId === ctx.binding.accountId) {
        mapping[id] = asset.uploaded.url;
        continue;
      }
      const { body } = await readAssetBody(id);
      const up = await uploadImage({ filename: asset.filename, mime: asset.mime, body, name: asset.filename }, ctx.cfg);
      mapping[id] = up.url;
      await recordAssetUpload(id, up.url, ctx.binding.accountId as string);
      uploadedCount++;
    }
    const publishedHtml = replaceLocalAssetIds(version.html, mapping);
    await appendStep(op.id, step('冻结发布快照', 'ok', uploadedCount, uploadedCount ? `已上传 ${uploadedCount} 张素材并替换为远端地址` : '没有需要上传的本地素材'));

    const lint = lintEmailHtml(publishedHtml, { knownAssetIds: [...assets.keys()] });
    if (!lint.ok) {
      const detail = lint.issues.filter((i) => i.level === 'error').map((i) => i.message).join('；');
      await appendStep(op.id, step('发布前检查', 'fail', null, detail));
      return await finishOperation(op.id, 'failed', { summary: `发布前检查未通过：${detail}` });
    }
    await appendStep(op.id, step('发布前检查', 'ok', null, '邮件 HTML 检查通过'));

    // 2) 决定创建还是更新；更新前核对远端是否被他人修改
    let remoteId = bundle.template.remote && bundle.template.remote.accountId === ctx.binding.accountId ? bundle.template.remote.remoteId : null;
    let fingerprint: string | null = null;

    if (remoteId) {
      const remote = await getRemoteTemplate(remoteId, ctx.cfg);
      assertHtmlEditable(remote.editorType, remoteId);
      const changed = Boolean(bundle.template.remote?.remoteFingerprint && remote.updated && remote.updated !== bundle.template.remote.remoteFingerprint);
      if (changed && input.onConflict !== 'new') {
        await appendStep(op.id, step('远端冲突检测', 'fail', null, `远端 updated=${remote.updated} 与记录不一致`));
        return await finishOperation(op.id, 'failed', {
          summary: '远端模板已被其他人修改，已阻止覆盖。请选择「另存为新模板」或先核对远端内容',
          resumable: false,
        });
      }
      if (changed) {
        await appendStep(op.id, step('远端冲突检测', 'skip', null, '远端已被修改，按操作员选择改为另存为新模板'));
        remoteId = null;
      } else {
        await appendStep(op.id, step('远端冲突检测', 'ok', null, '远端模板与记录一致'));
      }
    }

    if (remoteId) {
      const r = await updateRemoteTemplate(remoteId, { name: bundle.template.name, html: publishedHtml }, ctx.cfg);
      fingerprint = r.updated;
      await appendStep(op.id, step('更新远端模板', 'ok', 1, `模板 ${r.id} 内容已更新`));
    } else {
      const r = await createRemoteTemplate({ name: bundle.template.name, html: publishedHtml }, ctx.cfg);
      remoteId = r.id;
      fingerprint = r.updated;
      await appendStep(op.id, step('创建远端模板', 'ok', 1, `已创建 CODE 模板 ${r.id}`));
    }

    await bindRemoteTemplate(bundle.template.id, { accountId: ctx.binding.accountId as string, remoteId, syncedAt: nowIso(), remoteFingerprint: fingerprint });
    await cacheRemoteTemplate(bundle.template.id, { remoteId, name: bundle.template.name, fingerprint, checkedAt: nowIso() });
    return await finishOperation(op.id, 'done', { summary: `模板已同步到远端 ${remoteId}（不等同于发送，也不会创建 Campaign）` });
  } catch (e) {
    const outcome = outcomeOf(e);
    await appendStep(op.id, step('推送模板', outcome === 'unknown' ? 'unknown' : 'fail', null, messageOf(e)));
    return await finishOperation(op.id, outcome === 'unknown' ? 'unknown' : 'failed', {
      resumable: outcome === 'unknown',
      summary: outcome === 'unknown' ? '推送结果不明：请先到 Klaviyo 核对是否已创建/更新模板，再决定是否重试' : `推送失败：${messageOf(e)}`,
    });
  }
}

// ---------- 同步客户资料 ----------

export type ProfileSyncInput = { audienceId: string; fields?: unknown; currency?: string | null; confirm: string };

export async function runProfileSync(ctx: WriteContext, input: ProfileSyncInput): Promise<Operation> {
  const { audience, candidates } = await resolveCandidates(input.audienceId);
  const hash = candidateHashOf(audience.sourceRevision, candidates);
  if (input.confirm !== confirmProfiles(audience.id, hash)) {
    throw badRequest('确认信息与当前受众不一致，请重新确认后再同步', { expected: confirmProfiles(audience.id, hash) });
  }
  const fields = sanitizeFields(input.fields);
  if (!fields.length) throw badRequest('请至少选择一个要同步的字段');
  const currency = (input.currency ?? '').trim().toUpperCase() || null;
  if (fields.includes('ops_ltv') && !currency) throw badRequest('推送 ops_ltv 前必须确认货币单位');

  const op = await createOperation({
    kind: 'profile_sync',
    accountId: ctx.binding.accountId,
    storeKey: ctx.storeKey,
    fingerprint: sha256(`${ctx.binding.accountId ?? ''}|profile|${audience.id}|${hash}|${fields.join(',')}|${currency ?? ''}`),
    summary: `同步 ${candidates.length} 位客户的资料字段（不订阅、不加名单）`,
  });

  const deadline = Date.now() + SYNC_BUDGET_MS;
  const entries: Parameters<typeof cacheIdentities>[0] = [];
  const pending: string[] = [];
  let okCount = 0;
  let failCount = 0;
  let unknownCount = 0;

  for (const { customer, emailKey } of candidates) {
    if (Date.now() > deadline) {
      pending.push(customer.id);
      continue;
    }
    try {
      const res = await upsertProfile({ email: emailKey, properties: await buildProfileProperties(customer, fields, currency) }, ctx.cfg);
      entries.push({
        key: identityKey(audience.storeKey, ctx.binding.accountId, customer.id),
        identity: { profileId: res.profileId, email: emailKey, verifiedAt: nowIso(), source: 'import' },
        status: res.status,
      });
      okCount++;
    } catch (e) {
      if (outcomeOf(e) === 'unknown') {
        unknownCount++;
        pending.push(customer.id);
      } else {
        failCount++;
      }
      // 记录里只写内部 ID，不写邮箱
      await appendStep(op.id, step('写入资料', 'fail', 1, `${customer.id}：${messageOf(e)}`));
    }
  }

  await cacheIdentities(entries);
  await appendStep(op.id, step('写入资料', okCount ? 'ok' : 'fail', okCount, `成功 ${okCount} · 失败 ${failCount} · 结果不明 ${unknownCount}`));

  const resumeCtx = { audienceId: audience.id, fields, currency };
  if (pending.length) {
    return await finishOperation(op.id, 'awaiting_resume', {
      resumable: true,
      pending: { ids: pending.slice(0, 5000), note: '剩余的客户尚未处理，可能是时间预算用尽或写入结果不明；继续前请先核对远端', ...resumeCtx },
      summary: `资料已同步 ${okCount} 位，仍有 ${pending.length} 位待处理`,
    });
  }
  return await finishOperation(op.id, failCount ? 'partial' : 'done', {
    summary: `资料已同步 ${okCount} 位${failCount ? `，失败 ${failCount} 位` : ''}（未订阅、未加入名单）`,
  });
}

// ---------- 加入名单 ----------

export type ListSyncInput = { audienceId: string; listId: string; confirm: string };

export async function runListSync(ctx: WriteContext, input: ListSyncInput): Promise<Operation> {
  const { audience, candidates } = await resolveCandidates(input.audienceId);
  const hash = candidateHashOf(audience.sourceRevision, candidates);
  if (input.confirm !== confirmList(input.listId, audience.id, hash)) {
    throw badRequest('确认信息与当前受众不一致，请重新确认后再提交名单', { expected: confirmList(input.listId, audience.id, hash) });
  }
  if (audience.dataSource === 'mock') throw badRequest('演示数据不能写入真实名单');

  const op = await createOperation({
    kind: 'list_sync',
    accountId: ctx.binding.accountId,
    storeKey: ctx.storeKey,
    fingerprint: sha256(`${ctx.binding.accountId ?? ''}|list|${input.listId}|${audience.id}|${hash}`),
    summary: `向名单 ${input.listId} 添加符合规则的客户`,
  });
  const resumeCtx = { audienceId: audience.id, listId: input.listId };

  try {
    // 提交前刷新订阅/抑制状态：这是本期规则里唯一的合格性依据
    const emails = candidates.map((c) => c.emailKey);
    const remote = await lookupProfilesByEmail(emails, ctx.cfg);
    const byEmail = new Map(remote.filter((r) => r.email).map((r) => [r.email as string, r]));

    const entries: Parameters<typeof cacheIdentities>[0] = [];
    const eligible: string[] = [];
    let notFound = 0;
    let excluded = 0;

    for (const { customer, emailKey } of candidates) {
      const hit = byEmail.get(emailKey) ?? null;
      if (!hit) {
        notFound++;
        continue;
      }
      const status: KlaviyoMarketingStatus = hit.status ?? {
        canReceiveEmail: null,
        subscribed: null,
        consent: null,
        globalSuppressed: null,
        listSuppressed: null,
        checkedAt: nowIso(),
      };
      entries.push({
        key: identityKey(audience.storeKey, ctx.binding.accountId, customer.id),
        identity: { profileId: hit.id, email: emailKey, verifiedAt: nowIso(), source: 'lookup' },
        status,
      });
      if (!isMailable(status)) {
        excluded++;
        continue;
      }
      eligible.push(hit.id);
    }
    await cacheIdentities(entries);
    await appendStep(
      op.id,
      step('刷新订阅/抑制状态', 'ok', remote.length, `匹配 ${remote.length} · 未匹配 ${notFound} · 不符合本期订阅规则 ${excluded}`),
    );

    if (!eligible.length) {
      return await finishOperation(op.id, 'done', {
        summary: '按本期订阅规则没有符合条件的客户，未提交任何名单变更',
        pending: null,
      });
    }

    const deadline = Date.now() + SYNC_BUDGET_MS;
    const res = await addProfilesToList(input.listId, eligible, {
      cfg: ctx.cfg,
      batchSize: LIST_BATCH,
      deadline,
      onBatch: async (p) => await appendStep(op.id, step('加入名单', 'ok', p.sent, `已提交 ${p.sent}/${p.total}（第 ${p.batch} 批）`)),
    });

    if (res.remaining.length) {
      return await finishOperation(op.id, 'awaiting_resume', {
        resumable: true,
        pending: { ids: res.remaining, note: '剩余成员尚未提交，继续前会先读回名单成员做去重', ...resumeCtx },
        summary: `名单已更新：提交 ${res.sent} 位，仍有 ${res.remaining.length} 位待提交`,
      });
    }
    return await finishOperation(op.id, 'done', {
      summary: `名单已更新：提交 ${res.sent} 位（只增加成员，未做全量覆盖）`,
      pending: null,
    });
  } catch (e) {
    const outcome = outcomeOf(e);
    await appendStep(op.id, step('加入名单', outcome === 'unknown' ? 'unknown' : 'fail', null, messageOf(e)));
    return await finishOperation(op.id, outcome === 'unknown' ? 'unknown' : 'failed', {
      resumable: outcome === 'unknown',
      pending: outcome === 'unknown' ? { ids: [], note: '提交中断，尚未确认远端名单状态；继续前会先读回成员做去重', ...resumeCtx } : null,
      summary: outcome === 'unknown' ? '提交结果不明：请先到 Klaviyo 名单里核对成员，再决定是否继续' : `名单提交失败：${messageOf(e)}`,
    });
  }
}

// ---------- 恢复 ----------

/**
 * 恢复写入必须由页面显式点击触发，且只处理记录里挂起的条目。
 * 恢复前会重新校验受众快照；快照失效则拒绝，避免拿旧范围去写真实账号。
 */
export async function resumeOperation(req: Request, id: string): Promise<Operation> {
  const record = await getOperation(id);
  if (!record.resumable) throw conflict(`该执行记录当前状态是 ${record.status}，不需要恢复`);
  if (record.status !== 'awaiting_resume' && record.status !== 'unknown') {
    throw conflict(`该执行记录当前状态是 ${record.status}，不需要恢复`);
  }
  if (record.kind === 'template_sync') {
    throw conflict('模板推送结果不明时不能自动重试：请先到 Klaviyo 核对远端模板，再决定是否重新推送');
  }
  const ctx = await requireWrite(req, { customerData: true });
  const audienceId = record.pending?.audienceId;
  if (!audienceId) throw conflict('执行记录缺少受众信息，无法安全恢复，请重新发起');
  // 重新校验：过期或数据源已变化的快照一律拒绝
  const { audience } = await resolveCandidates(audienceId);

  if (record.kind === 'profile_sync') return resumeProfileSync(ctx, record, audience.storeKey);
  if (record.kind === 'list_sync') return resumeListSync(ctx, record);
  throw conflict(`不支持的恢复类型：${record.kind}`);
}

async function resumeProfileSync(ctx: WriteContext, record: Operation, storeKey: string): Promise<Operation> {
  const fields = sanitizeFields(record.pending?.fields);
  const currency = record.pending?.currency ?? null;
  if (!fields.length) throw conflict('执行记录缺少字段信息，无法安全恢复，请重新发起');
  if (fields.includes('ops_ltv') && !currency) throw conflict('原操作缺少已确认的货币单位，无法继续推送 LTV');

  const rows = await customersByIds(record.pending?.ids ?? []);
  const deadline = Date.now() + SYNC_BUDGET_MS;
  const entries: Parameters<typeof cacheIdentities>[0] = [];
  const stillPending: string[] = [];
  let okCount = 0;
  let failCount = 0;
  let unknownCount = 0;

  for (const r of rows) {
    if (!r || r.emailStatus !== 'valid' || !r.emailKey) {
      failCount++;
      continue;
    }
    if (Date.now() > deadline) {
      stillPending.push(r.id);
      continue;
    }
    try {
      // 资料写入是按键值合并的 upsert，重复提交同一份属性不会产生副作用
      const res = await upsertProfile({ email: r.emailKey, properties: await buildProfileProperties(r, fields, currency) }, ctx.cfg);
      entries.push({
        key: identityKey(storeKey, ctx.binding.accountId, r.id),
        identity: { profileId: res.profileId, email: r.emailKey, verifiedAt: nowIso(), source: 'import' },
        status: res.status,
      });
      okCount++;
    } catch (e) {
      if (outcomeOf(e) === 'unknown') {
        unknownCount++;
        stillPending.push(r.id);
      } else {
        failCount++;
      }
      await appendStep(record.id, step('恢复写入资料', 'fail', 1, `${r.id}：${messageOf(e)}`));
    }
  }

  await cacheIdentities(entries);
  await appendStep(record.id, step('恢复写入资料', okCount ? 'ok' : 'fail', okCount, `成功 ${okCount} · 失败 ${failCount} · 结果不明 ${unknownCount}`));

  if (stillPending.length) {
    return await finishOperation(record.id, 'awaiting_resume', {
      resumable: true,
      pending: { ...record.pending, ids: stillPending, note: '仍有客户未处理' } as Operation['pending'],
      summary: `资料已继续同步 ${okCount} 位，剩余 ${stillPending.length} 位`,
    });
  }
  return await finishOperation(record.id, failCount ? 'partial' : 'done', {
    resumable: false,
    pending: null,
    summary: `资料已继续同步 ${okCount} 位${failCount ? `，失败 ${failCount} 位` : ''}`,
  });
}

async function resumeListSync(ctx: WriteContext, record: Operation): Promise<Operation> {
  const listId = record.pending?.listId;
  if (!listId) throw conflict('执行记录缺少目标名单，无法安全恢复');

  // 应用级去重：先读回当前成员，只提交确实还不是成员的 profile。
  // 不假定 Klaviyo 的「加入名单」接口本身幂等；名单过大时不做全量枚举。
  const members = await fetchListMemberIds(listId, ctx.cfg);
  if (!members.complete) {
    throw conflict('名单成员过多，无法在不全量枚举的前提下安全去重；请到 Klaviyo 人工核对后再操作');
  }
  const requested = record.pending?.ids ?? [];
  const todo = requested.filter((pid) => !members.ids.has(pid));
  await appendStep(record.id, step('恢复前核对名单成员', 'ok', requested.length - todo.length, `已确认 ${requested.length - todo.length} 位已在名单中，将跳过`));

  if (!todo.length) {
    return await finishOperation(record.id, 'done', { resumable: false, pending: null, summary: '剩余成员都已在名单中，无需再提交' });
  }

  const deadline = Date.now() + SYNC_BUDGET_MS;
  try {
    const res = await addProfilesToList(listId, todo, {
      cfg: ctx.cfg,
      batchSize: LIST_BATCH,
      deadline,
      onBatch: async (p) => await appendStep(record.id, step('恢复加入名单', 'ok', p.sent, `已提交 ${p.sent}/${p.total}`)),
    });
    if (res.remaining.length) {
      return await finishOperation(record.id, 'awaiting_resume', {
        resumable: true,
        pending: { ...record.pending, ids: res.remaining } as Operation['pending'],
        summary: `已继续提交 ${res.sent} 位，剩余 ${res.remaining.length} 位`,
      });
    }
    return await finishOperation(record.id, 'done', { resumable: false, pending: null, summary: `已继续提交 ${res.sent} 位` });
  } catch (e) {
    const outcome = outcomeOf(e);
    await appendStep(record.id, step('恢复加入名单', outcome === 'unknown' ? 'unknown' : 'fail', null, messageOf(e)));
    return await finishOperation(record.id, outcome === 'unknown' ? 'unknown' : 'failed', {
      resumable: outcome === 'unknown',
      summary: `继续提交失败：${messageOf(e)}`,
    });
  }
}