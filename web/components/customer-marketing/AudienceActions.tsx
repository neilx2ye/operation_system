'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { describeFilters, type Filters } from '@/lib/customer-segmentation';
import type { AudienceSnapshot, Preparation, Template } from '@/lib/edm/types';
import { int } from '@/lib/format';
import { formatDateTime } from './MarketingStatusTag';
import { errorText, readApiError } from './useMarketingStatus';
import styles from './customerMarketing.module.css';

// 用户页的 EDM 受众面板：范围选择 → 预览 → 保存快照 → 刷新状态 / 用于邮件设计 / 同步名单。
// 每个动作只做一件事，外部写入前必须单独确认，且确认只覆盖当次操作。

type Mode = 'ids' | 'filters';

/** 与服务端 frozen contract 一致的请求体 */
type AudienceRequest = { mode: Mode; ids?: string[]; filters?: Filters; tag?: string | null; query?: string };

/** POST /api/edm/audiences/preview 的响应（与 lib/edm/service.ts 的 AudiencePreview 对应） */
type AudiencePreview = {
  storeKey: string;
  dataSource: 'mock' | 'shopify';
  sourceRevision: string;
  syncedAt: string | null;
  mode: Mode;
  scopeLabel: string;
  filters: string[];
  total: number;
  validEmail: number;
  duplicateEmail: number;
  mailable: number;
  pending: number;
  excluded: { reason: string; count: number }[];
  mock: boolean;
  candidateHash: string;
  expiresAt: string;
};

type LookupResponse = {
  summary: { total: number; matched: number; notFound: number; failed: number; mailable: number; pending: number };
  results: { customerRef: string; status: 'matched' | 'not_found' | 'error'; profileId: string | null; checkedAt: string }[];
};

type IntegrationStatus = {
  configured?: boolean;
  writesEnabled?: boolean;
  /** GET /api/integrations/klaviyo/status 的实际形状：账号嵌在 account 里 */
  account?: { id: string | null; label: string } | null;
  storeKey?: string;
  defaultListId?: string | null;
  defaultListName?: string;
  // 兼容把绑定字段平铺 / 放在 binding 下的实现，读不到就显示未知
  accountId?: string | null;
  accountLabel?: string;
  binding?: {
    accountId?: string | null;
    accountLabel?: string;
    storeKey?: string;
    defaultListId?: string | null;
    defaultListName?: string;
    writesEnabled?: boolean;
  };
};

type TemplateListResponse = { templates: Template[] };
type TemplateWriteResponse = { template: Template };
type PreparationResponse = { preparation: Preparation };

type SyncOperation = {
  id?: string;
  status?: string;
  summary?: string;
  resumable?: boolean;
  pending?: { ids?: string[]; note?: string } | null;
};
type SyncResponse = { operation?: SyncOperation };

/** POST /api/integrations/klaviyo/preflight 的响应；confirm 必须原样回传给 sync */
type PreflightResponse = {
  ok: boolean;
  blockers: string[];
  warnings: string[];
  summary: Record<string, unknown>;
  confirm: string;
};

/** 已知排除原因的中文解释；未列出的一律显示原始 reason 并提示查看服务端 */
const EXCLUSION_TEXT: Record<string, string> = {
  not_found: '在当前数据源中找不到该客户（可能已删除或不属于当前店铺）',
  outside_source: '不属于当前数据源 / 店铺',
  no_email: '没有邮箱，无法用于邮件营销',
  placeholder_email: '邮箱是「(无邮箱)」等占位值',
  invalid_email: '邮箱格式不合法',
  duplicate_email: '与其他客户邮箱重复，只保留第一位',
  mock_source: '演示数据（Mock）不能用于真实写入',
};

/** 资料同步的白名单字段；不修改订阅状态，也不覆盖 Klaviyo/Shopify 的原生字段 */
const SYNC_FIELDS =
  'profile 引用（ops_customer_ref）、ops_segment、ops_tags、ops_orders、ops_ltv、ops_currency、ops_last_order_at；不包含订阅 / 抑制状态修改';

type ProfileField = 'ops_customer_ref' | 'ops_segment' | 'ops_tags' | 'ops_orders' | 'ops_ltv' | 'ops_currency' | 'ops_last_order_at';

const PROFILE_FIELDS: { key: ProfileField; label: string }[] = [
  { key: 'ops_customer_ref', label: '客户引用' },
  { key: 'ops_segment', label: '分层' },
  { key: 'ops_tags', label: '标签' },
  { key: 'ops_orders', label: '订单数' },
  { key: 'ops_last_order_at', label: '最近下单时间' },
  { key: 'ops_ltv', label: '净 LTV（需先确认货币）' },
  { key: 'ops_currency', label: '货币代码' },
];

/** 默认不勾选 ops_ltv / ops_currency：货币无法核实时不推送裸金额 */
const DEFAULT_PROFILE_FIELDS: ProfileField[] = ['ops_customer_ref', 'ops_segment', 'ops_tags', 'ops_orders', 'ops_last_order_at'];

const NEW_TEMPLATE = '__new__';

function summaryStr(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v : '';
}

function summaryNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 预检 summary 里的「账号 / 店铺」展示，读不到就用本地绑定兜底，仍读不到显示未知，不猜 */
function summaryAccount(s: Record<string, unknown>, fallbackLabel = '', fallbackId: string | null = null): string {
  const id = summaryStr(s.account) || fallbackId || '';
  const label = summaryStr(s.accountLabel) || fallbackLabel;
  if (label && id) return `${label}（${id}）`;
  return label || id || '未知';
}

function countText(v: unknown): string {
  const n = summaryNum(v);
  return n === null ? '未知' : `${int(n)} 人`;
}

function fieldCodesText(v: unknown): string {
  if (!Array.isArray(v) || v.length === 0) return '未选择';
  return v.map((x) => String(x)).join('、');
}

/** 预检的 blockers（阻止提交）与 warnings（提醒但不阻止） */
function PreflightMessages({ result }: { result: PreflightResponse }) {
  return (
    <>
      {result.blockers.length > 0 && (
        <div className={styles.danger}>
          预检未通过，已阻止提交：
          <ul className={styles.list}>
            {result.blockers.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </div>
      )}
      {result.warnings.length > 0 && (
        <div className={styles.warn}>
          提醒（不阻止提交）：
          <ul className={styles.list}>
            {result.warnings.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/** 执行结果文案：失败、结果不明、部分完成都不算成功；成功只说名单已更新 / 资料已同步 */
function operationNotice(op: SyncOperation | undefined, okLabel: string, failLabel: string): { ok: boolean; text: string } {
  if (!op) return { ok: true, text: `${okLabel}（服务端未返回执行记录，请在执行记录中核对）` };
  const tail = [op.summary, op.id ? `执行记录 ${op.id}` : ''].filter(Boolean).join(' · ');
  if (op.status === 'failed') return { ok: false, text: `${failLabel}：${tail}` };
  if (op.status === 'unknown') return { ok: false, text: `提交结果不明，不要盲目重试：${tail}。请先到 Klaviyo 核对再决定` };
  if (op.status === 'partial' || op.status === 'awaiting_resume') {
    return { ok: false, text: `部分完成：${tail}${op.resumable ? '（仍有待处理项，核对后可在执行记录里继续）' : ''}` };
  }
  if (op.status && op.status !== 'done') return { ok: false, text: `执行状态 ${op.status}：${tail}` };
  return { ok: true, text: `${okLabel}：${tail}` };
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: 'neg' | 'ok' }) {
  const cls = [styles.metricValue, tone === 'neg' ? styles.metricNeg : '', tone === 'ok' ? styles.metricOk : ''].filter(Boolean).join(' ');
  return (
    <div className={styles.metric}>
      <div className={styles.metricLabel}>{label}</div>
      <div className={cls}>{int(value)}</div>
    </div>
  );
}

/** 快照的作用范围描述；快照本身不带 scopeLabel，这里只根据 mode + 人数还原 */
function snapshotScope(s: AudienceSnapshot): string {
  return `${s.mode === 'ids' ? '勾选用户' : '当前筛选结果'} · ${s.counts.total} 人`;
}

/** 预检结果的归属 key：快照 / 名单 / 字段 / 货币任一变化，旧 confirm 都不再可用 */
function listPreflightKeyOf(audienceId: string, listId: string): string {
  return `${audienceId}|${listId}`;
}

function profilePreflightKeyOf(audienceId: string, fields: ProfileField[], currency: string): string {
  return `${audienceId}|${[...fields].sort().join(',')}|${currency}`;
}

export function AudienceActions({
  filters,
  tag,
  query,
  filteredCount,
  selectedIds,
  dataSource,
  onStatusRefreshed,
}: {
  filters: Filters;
  tag: string | null;
  /** 自由搜索（可能含邮箱）：只进入同源请求体，不写 URL、不写 localStorage、不打印日志 */
  query: string;
  /** 列表当前可见行数，仅用于范围提示；权威人数以服务端预览为准 */
  filteredCount: number;
  selectedIds: ReadonlySet<string>;
  dataSource: 'mock' | 'shopify' | null;
  /** 刷新营销状态成功后通知列表重新读取状态缓存 */
  onStatusRefreshed?: () => void;
}) {
  const router = useRouter();

  const [mode, setMode] = useState<Mode>('filters');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const [preview, setPreview] = useState<AudiencePreview | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<AudienceSnapshot | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [lookup, setLookup] = useState<LookupResponse | null>(null);
  const [statusRefreshedFor, setStatusRefreshedFor] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'lookup' | 'listSync' | null>(null);

  const [integration, setIntegration] = useState<IntegrationStatus | null>(null);
  const [integrationError, setIntegrationError] = useState<string | null>(null);

  const [prepareOpen, setPrepareOpen] = useState(false);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [templateChoice, setTemplateChoice] = useState('');
  const [newTemplateName, setNewTemplateName] = useState('');

  // 预检：confirm 串由服务端签发并绑定 (listId, audienceId, candidateHash)，
  // 条件一变必须重新预检，绝不能复用旧串。
  const [listPreflight, setListPreflight] = useState<PreflightResponse | null>(null);
  const [listPreflightFor, setListPreflightFor] = useState<string | null>(null);
  const [profilePreflight, setProfilePreflight] = useState<PreflightResponse | null>(null);
  const [profilePreflightFor, setProfilePreflightFor] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileFields, setProfileFields] = useState<ProfileField[]>(DEFAULT_PROFILE_FIELDS);
  const [profileCurrency, setProfileCurrency] = useState('');
  /** 预检请求序号：范围变化或新预检发起后，旧的响应一律丢弃 */
  const listPreflightSeq = useRef(0);
  const profilePreflightSeq = useRef(0);

  /** 作废所有预检结果与在飞响应；confirm 串绝不复用（busy 也要清，否则按钮会卡住） */
  const invalidatePreflights = useCallback(() => {
    listPreflightSeq.current += 1;
    profilePreflightSeq.current += 1;
    setListPreflight(null);
    setListPreflightFor(null);
    setProfilePreflight(null);
    setProfilePreflightFor(null);
    setBusy((b) => (b === 'preflightList' || b === 'preflightProfile' ? null : b));
  }, []);

  useEffect(() => {
    let alive = true;
    fetch('/api/integrations/klaviyo/status')
      .then(async (r) => {
        if (!r.ok) throw new Error(await readApiError(r));
        return (await r.json()) as IntegrationStatus;
      })
      .then((d) => {
        if (alive) {
          setIntegration(d);
          setIntegrationError(null);
        }
      })
      .catch((e) => {
        if (alive) setIntegrationError(errorText(e, 'Klaviyo 连接状态读取失败'));
      });
    return () => {
      alive = false;
    };
  }, []);

  const request = useMemo<AudienceRequest>(
    () => (mode === 'ids' ? { mode: 'ids', ids: [...selectedIds] } : { mode: 'filters', filters, tag, query }),
    [mode, selectedIds, filters, tag, query],
  );
  const requestKey = useMemo(() => JSON.stringify(request), [request]);

  // 范围一变，之前的预览 / 快照 / 查询结果全部作废，必须重新确认（绝不把旧范围沿用下去）
  const firstKey = useRef(true);
  useEffect(() => {
    if (firstKey.current) {
      firstKey.current = false;
      return;
    }
    setPreview(null);
    setPreviewKey(null);
    setSnapshot(null);
    setSavedKey(null);
    setLookup(null);
    setStatusRefreshedFor(null);
    setConfirm(null);
    setNotice(null);
    // 范围变化后旧的 confirm 串一律作废，正在飞的预检响应也丢弃
    invalidatePreflights();
  }, [requestKey, invalidatePreflights]);

  // 勾选从无到有时默认切到「勾选用户」，从有到无时回到「当前筛选结果」
  const prevSel = useRef(selectedIds.size);
  useEffect(() => {
    const prev = prevSel.current;
    prevSel.current = selectedIds.size;
    if (prev === 0 && selectedIds.size > 0) setMode('ids');
    else if (prev > 0 && selectedIds.size === 0) setMode('filters');
  }, [selectedIds]);

  const previewFresh = preview !== null && previewKey === requestKey;
  const snapshotFresh = snapshot !== null && savedKey === requestKey;
  const filterSummary = useMemo(() => describeFilters(filters, tag), [filters, tag]);
  const noCondition = mode === 'filters' && filterSummary.length === 0 && !query.trim();
  const hasQuery = mode === 'filters' && query.trim().length > 0;

  const binding = integration?.binding;
  const accountId = integration?.account?.id ?? binding?.accountId ?? integration?.accountId ?? null;
  const accountLabel = integration?.account?.label ?? binding?.accountLabel ?? integration?.accountLabel ?? '';
  const storeKey = binding?.storeKey ?? integration?.storeKey ?? snapshot?.storeKey ?? null;
  const listId = binding?.defaultListId ?? integration?.defaultListId ?? null;
  const listName = binding?.defaultListName ?? integration?.defaultListName ?? '';
  const writesEnabled = binding?.writesEnabled ?? integration?.writesEnabled ?? false;

  const syncBlockedReason =
    dataSource === null
      ? '数据源状态尚未就绪，请稍后重试'
      : dataSource === 'mock'
        ? '当前是演示数据 (Mock)，服务端会拒绝真实写入'
        : integrationError
          ? '无法确认 Klaviyo 写入开关（连接状态读取失败）'
          : integration === null
            ? '正在读取 Klaviyo 连接状态…'
            : !writesEnabled
              ? '服务端写入开关未开启（KLAVIYO_ENABLE_WRITES 不是 true）'
              : !listId
                ? '未配置默认目标名单（请先在设置页绑定）'
                : null;

  // 预检 key：快照 / 目标名单 / 字段 / 货币任一变化，都必须重新预检，旧 confirm 串不再可用
  const listTargetKey = snapshot && listId ? listPreflightKeyOf(snapshot.id, listId) : null;
  const listPreflightFresh = listPreflight !== null && listPreflightFor !== null && listPreflightFor === listTargetKey;
  const listConfirmReady = listPreflightFresh && listPreflight !== null && listPreflight.ok;

  const profileCurrencyValue = profileCurrency.trim().toUpperCase();
  const profileTargetKey = snapshot ? profilePreflightKeyOf(snapshot.id, profileFields, profileCurrencyValue) : null;
  const profilePreflightFresh = profilePreflight !== null && profilePreflightFor !== null && profilePreflightFor === profileTargetKey;
  const profileConfirmReady = profilePreflightFresh && profilePreflight !== null && profilePreflight.ok;
  const ltvNeedsCurrency = profileFields.includes('ops_ltv') && !profileCurrencyValue;
  const profileBlockedReason =
    dataSource === null
      ? '数据源状态尚未就绪，请稍后重试'
      : dataSource === 'mock'
        ? '当前是演示数据 (Mock)，服务端会拒绝真实写入'
        : integrationError
          ? '无法确认 Klaviyo 写入开关（连接状态读取失败）'
          : integration === null
            ? '正在读取 Klaviyo 连接状态…'
            : !writesEnabled
              ? '服务端写入开关未开启（KLAVIYO_ENABLE_WRITES 不是 true）'
              : null;

  const runPreview = async () => {
    setBusy('preview');
    setNotice(null);
    try {
      const res = await fetch('/api/edm/audiences/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      const data = (await res.json()) as { preview: AudiencePreview };
      setPreview(data.preview);
      setPreviewKey(requestKey);
    } catch (e) {
      setNotice({ ok: false, text: errorText(e, '预览失败') });
    } finally {
      setBusy(null);
    }
  };

  const saveAudience = async () => {
    if (!previewFresh) {
      setNotice({ ok: false, text: '请先预览当前范围，确认人数与排除原因后再保存快照' });
      return;
    }
    setBusy('save');
    setNotice(null);
    try {
      // 快照必须与预览使用同一个请求体，否则保存下来的范围会和刚预览的不一致。
      // 请求只发往同源服务端，自由搜索里的邮箱只用于服务端计算/哈希。
      const res = await fetch('/api/edm/audiences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      const data = (await res.json()) as { audience: AudienceSnapshot };
      setSnapshot(data.audience);
      setSavedKey(requestKey);
      setLookup(null);
      setStatusRefreshedFor(null);
      // 新快照 = 新受众：旧预检与 confirm 串立即作废
      invalidatePreflights();
      setNotice({ ok: true, text: `受众快照已保存：${data.audience.id}，有效期至 ${formatDateTime(data.audience.expiresAt)}` });
    } catch (e) {
      setNotice({ ok: false, text: errorText(e, '受众快照保存失败') });
    } finally {
      setBusy(null);
    }
  };

  const runLookup = async () => {
    if (!snapshot) return;
    setBusy('lookup');
    setNotice(null);
    try {
      const res = await fetch('/api/integrations/klaviyo/profiles/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audienceId: snapshot.id }),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      const data = (await res.json()) as LookupResponse;
      setLookup(data);
      setStatusRefreshedFor(snapshot.id);
      setConfirm(null);
      // 状态缓存变了，之前预检的 blocker / 人数摘要可能已经过时：作废，要求重新预检
      invalidatePreflights();
      onStatusRefreshed?.();
      if (data.summary.failed > 0) {
        setNotice({ ok: false, text: `有 ${data.summary.failed} 位客户查询失败，他们不会进入可营销集合，请稍后重试` });
      } else {
        setNotice({ ok: true, text: `营销状态已刷新：匹配 ${data.summary.matched} 位，未找到 ${data.summary.notFound} 位` });
      }
    } catch (e) {
      setLookup(null);
      setNotice({ ok: false, text: errorText(e, '营销状态刷新失败') });
    } finally {
      setBusy(null);
    }
  };

  const openPrepare = async () => {
    setPrepareOpen(true);
    if (templates !== null) return;
    setBusy('templates');
    try {
      const res = await fetch('/api/edm/templates');
      if (!res.ok) throw new Error(await readApiError(res));
      const data = (await res.json()) as TemplateListResponse;
      setTemplates(data.templates ?? []);
      setTemplatesError(null);
    } catch (e) {
      setTemplatesError(errorText(e, '模板列表读取失败'));
    } finally {
      setBusy(null);
    }
  };

  /** 保存本地准备记录（模板版本 + 受众），然后打开设计器；它不是 Campaign，也不发送邮件 */
  const openDesigner = async (templateId: string) => {
    if (!snapshot) return;
    const res = await fetch('/api/edm/preparations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId, audienceId: snapshot.id }),
    });
    if (!res.ok) throw new Error(await readApiError(res));
    const data = (await res.json()) as PreparationResponse;
    setNotice({ ok: true, text: `准备记录已保存：${data.preparation.id}，正在打开设计器…` });
    router.push('/edm/templates/' + templateId);
  };

  const savePreparationFor = async (templateId: string) => {
    if (!snapshotFresh) return;
    setBusy('prepare');
    setNotice(null);
    try {
      await openDesigner(templateId);
    } catch (e) {
      setNotice({ ok: false, text: errorText(e, '准备记录保存失败') });
    } finally {
      setBusy(null);
    }
  };

  const createTemplateAndSave = async () => {
    const name = newTemplateName.trim();
    if (!name || !snapshotFresh) return;
    setBusy('prepare');
    setNotice(null);
    try {
      const res = await fetch('/api/edm/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      const data = (await res.json()) as TemplateWriteResponse;
      const created = data.template;
      if (!created?.id) throw new Error('模板已创建，但响应缺少模板 ID，请在模板库中确认');
      setTemplates((prev) => (prev ? [created, ...prev] : [created]));
      setNewTemplateName('');
      await openDesigner(created.id);
    } catch (e) {
      setNotice({ ok: false, text: errorText(e, '新建模板失败') });
    } finally {
      setBusy(null);
    }
  };

  /** 名单同步预检：不写入，只核对账号/店铺/名单/受众并签发 confirm 串 */
  const runListPreflight = async () => {
    if (!snapshot || !listId) return;
    const mine = ++listPreflightSeq.current;
    setBusy('preflightList');
    setNotice(null);
    try {
      const res = await fetch('/api/integrations/klaviyo/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'list', audienceId: snapshot.id, listId }),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      const data = (await res.json()) as PreflightResponse;
      if (mine !== listPreflightSeq.current) return;
      setListPreflight(data);
      setListPreflightFor(listPreflightKeyOf(snapshot.id, listId));
    } catch (e) {
      if (mine !== listPreflightSeq.current) return;
      setListPreflight(null);
      setListPreflightFor(null);
      setNotice({ ok: false, text: errorText(e, '名单同步预检失败') });
    } finally {
      // 只清自己的 busy：另一种预检可能正在跑
      if (mine === listPreflightSeq.current) setBusy((b) => (b === 'preflightList' ? null : b));
    }
  };

  /** 资料同步预检：字段与货币确认后才能签发 confirm 串 */
  const runProfilePreflight = async () => {
    if (!snapshot) return;
    const mine = ++profilePreflightSeq.current;
    const currency = profileCurrency.trim().toUpperCase();
    setBusy('preflightProfile');
    setNotice(null);
    try {
      const res = await fetch('/api/integrations/klaviyo/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'profile', audienceId: snapshot.id, fields: profileFields, currency: currency || null }),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      const data = (await res.json()) as PreflightResponse;
      if (mine !== profilePreflightSeq.current) return;
      setProfilePreflight(data);
      setProfilePreflightFor(profilePreflightKeyOf(snapshot.id, profileFields, currency));
    } catch (e) {
      if (mine !== profilePreflightSeq.current) return;
      setProfilePreflight(null);
      setProfilePreflightFor(null);
      setNotice({ ok: false, text: errorText(e, '资料同步预检失败') });
    } finally {
      // 只清自己的 busy：另一种预检可能正在跑
      if (mine === profilePreflightSeq.current) setBusy((b) => (b === 'preflightProfile' ? null : b));
    }
  };

  const runListSync = async () => {
    if (!snapshot || !listId || !listConfirmReady || !listPreflight) {
      setNotice({ ok: false, text: '请先完成预检并确认账号、店铺、名单、范围与人数' });
      return;
    }
    setBusy('sync');
    setNotice(null);
    try {
      const res = await fetch('/api/integrations/klaviyo/lists/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // confirm 必须原样回传预检签发的串；它绑定 (listId, audienceId, candidateHash)
        body: JSON.stringify({ audienceId: snapshot.id, listId, confirm: listPreflight.confirm }),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      let data: SyncResponse = {};
      try {
        data = (await res.json()) as SyncResponse;
      } catch {
        // 成功响应体不是 JSON 时只显示通用结果
      }
      const n = operationNotice(data.operation, '名单已更新', '名单同步失败');
      setNotice(n.ok ? { ok: true, text: `${n.text}。加入名单不代表用户同意营销，也不代表邮件已发送。` } : n);
      setConfirm(null);
      setListPreflight(null);
      setListPreflightFor(null);
    } catch (e) {
      setNotice({ ok: false, text: errorText(e, '名单同步失败') });
    } finally {
      setBusy(null);
    }
  };

  const runProfileSync = async () => {
    if (!snapshot || !profileConfirmReady || !profilePreflight) {
      setNotice({ ok: false, text: '请先完成预检并确认字段与货币' });
      return;
    }
    const currency = profileCurrency.trim().toUpperCase() || null;
    setBusy('profileSync');
    setNotice(null);
    try {
      const res = await fetch('/api/integrations/klaviyo/profiles/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audienceId: snapshot.id, fields: profileFields, currency, confirm: profilePreflight.confirm }),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      let data: SyncResponse = {};
      try {
        data = (await res.json()) as SyncResponse;
      } catch {
        // 成功响应体不是 JSON 时只显示通用结果
      }
      const n = operationNotice(data.operation, '资料已同步', '资料同步失败');
      setNotice(n.ok ? { ok: true, text: `${n.text}（不订阅、不加名单、不取消抑制）` } : n);
      setProfilePreflight(null);
      setProfilePreflightFor(null);
    } catch (e) {
      setNotice({ ok: false, text: errorText(e, '资料同步失败') });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <b className={styles.panelTitle}>邮件受众（EDM）</b>
        <span className={styles.muted}>选择范围 → 预览人数 → 保存快照 → 刷新状态 / 用于邮件设计 / 预检后同步</span>
      </div>

      {integrationError && <div className={styles.danger}>Klaviyo 连接状态读取失败：{integrationError}；写入相关的操作会保持不可用。</div>}

      <div className={styles.block}>
        <div className={styles.blockTitle}>作用范围</div>
        <div className={styles.scopeRow}>
          <button
            className={mode === 'ids' ? `${styles.scopeBtn} ${styles.scopeBtnOn}` : styles.scopeBtn}
            onClick={() => setMode('ids')}
            disabled={selectedIds.size === 0}
          >
            勾选用户 <span className={styles.scopeCount}>{selectedIds.size}</span>
          </button>
          <button className={mode === 'filters' ? `${styles.scopeBtn} ${styles.scopeBtnOn}` : styles.scopeBtn} onClick={() => setMode('filters')}>
            当前筛选结果 <span className={styles.scopeCount}>{filteredCount}</span>
          </button>
        </div>
        <div className={styles.hint}>
          {mode === 'ids'
            ? `只作用于列表里勾选的 ${selectedIds.size} 位客户，未勾选的客户不受影响。`
            : `作用于当前筛选结果（分层/渠道/国家/首购月/弃购 + 标签 + 自由搜索）；列表可见 ${filteredCount} 行，最终人数以服务端预览为准。`}
        </div>
        {noCondition && <div className={styles.warn}>当前筛选结果没有设置任何条件：范围等于全部客户，请确认这是你要的范围。</div>}
        {hasQuery && <div className={styles.hint}>自由搜索已生效（关键字可能含邮箱，不在此处回显，也不会写入 URL 或日志）。</div>}
      </div>

      <div className={styles.btnRow}>
        <button className={styles.btnPrimary} onClick={() => void runPreview()} disabled={busy === 'preview' || (mode === 'ids' && selectedIds.size === 0)}>
          {busy === 'preview' ? '预览中…' : '预览人数与排除原因'}
        </button>
        <button onClick={() => void saveAudience()} disabled={!previewFresh || busy === 'save'}>
          {busy === 'save' ? '保存中…' : '保存为受众快照'}
        </button>
        {previewFresh && <span className={styles.muted}>预览范围与当前选择一致，可以保存</span>}
      </div>

      {preview && (
        <div className={styles.block}>
          <div className={styles.blockTitle}>预览结果{previewFresh ? '' : '（范围已变化，需重新预览）'}</div>
          <div className={styles.metrics}>
            <Metric label="总人数" value={preview.total} />
            <Metric label="邮箱有效" value={preview.validEmail} />
            <Metric label="重复邮箱" value={preview.duplicateEmail} />
            <Metric label="可用于营销" value={preview.mailable} tone="ok" />
            <Metric label="待确认" value={preview.pending} />
          </div>
          <div className={styles.hint}>
            作用范围：{preview.scopeLabel} · {preview.mock ? '演示数据 (Mock)' : `真实数据源 ${preview.storeKey}`} · 数据源指纹{' '}
            {preview.sourceRevision.slice(0, 8)} · 范围指纹 <code className={styles.mono}>{preview.candidateHash.slice(0, 8)}</code>（变化说明命中人群已变）
          </div>
          <div className={styles.hint}>
            筛选条件：{preview.filters.length ? preview.filters.join(' · ') : '无筛选条件'}
            {hasQuery ? ' · 自由搜索已应用' : ''}
          </div>
          {noCondition && <div className={styles.warn}>服务端确认：这个范围就是全部客户（没有任何筛选条件）。</div>}
          {preview.mock && <div className={styles.warn}>服务端确认这是演示数据：不能推送到 Klaviyo。</div>}
          <div className={styles.blockTitle}>排除原因明细</div>
          {preview.excluded.length === 0 ? (
            <div className={styles.muted}>没有排除项。</div>
          ) : (
            <div className={styles.reasons}>
              {preview.excluded.map((x) => (
                <div key={x.reason} className={styles.reason}>
                  <code className={styles.reasonCode}>{x.reason}</code>
                  <span className={styles.reasonText}>{EXCLUSION_TEXT[x.reason] ?? '未知原因，请对照服务端日志'}</span>
                  <span className={styles.reasonCount}>{int(x.count)} 人</span>
                </div>
              ))}
            </div>
          )}
          <div className={styles.hint}>本次预览对应快照的到期时间约为 {formatDateTime(preview.expiresAt)}；数据源变化后需要重新预览。</div>
        </div>
      )}

      {snapshot && (
        <div className={styles.block}>
          <div className={styles.blockTitle}>受众快照</div>
          <div className={styles.hint}>
            快照 ID <code className={styles.mono}>{snapshot.id}</code> · 到期 {formatDateTime(snapshot.expiresAt)} · 总人数 {int(snapshot.counts.total)} · 邮箱有效{' '}
            {int(snapshot.counts.validEmail)} · 重复邮箱 {int(snapshot.counts.duplicateEmail)} · 可用于营销 {int(snapshot.counts.mailable)} · 待确认{' '}
            {int(snapshot.counts.pending)}
          </div>
          {!snapshotFresh && <div className={styles.warn}>当前范围已经变化：这个快照不再对应当前的筛选 / 勾选，后续操作已停用，请重新预览并保存。</div>}
        </div>
      )}

      <div className={styles.block}>
        <div className={styles.blockTitle}>刷新营销状态</div>
        <div className={styles.hint}>
          按已保存的快照读取 Klaviyo Profile 的订阅与抑制状态并更新本地缓存；只读，不创建或修改资料、不加入名单、不发送邮件。
        </div>
        {!snapshotFresh ? (
          <div className={styles.hint}>请先保存当前范围的受众快照。</div>
        ) : confirm === 'lookup' ? (
          <div className={styles.confirm}>
            <div className={styles.confirmHead}>确认刷新营销状态（只读）</div>
            <div className={styles.confirmGrid}>
              <span className={styles.confirmK}>快照</span>
              <span className={styles.confirmV}>
                <code className={styles.mono}>{snapshot.id}</code>
              </span>
              <span className={styles.confirmK}>范围</span>
              <span className={styles.confirmV}>{snapshotScope(snapshot)}</span>
              <span className={styles.confirmK}>影响</span>
              <span className={styles.confirmV}>读取 Profile 订阅 / 抑制状态并更新本地缓存，不写入远端</span>
            </div>
            <div className={styles.confirmActions}>
              <button className={styles.btnPrimary} onClick={() => void runLookup()} disabled={busy === 'lookup'}>
                {busy === 'lookup' ? '查询中…' : '确认刷新'}
              </button>
              <button onClick={() => setConfirm(null)}>取消</button>
            </div>
            <div className={styles.hint}>这次确认只对本次快照有效，不会被记住为「总是允许」。</div>
          </div>
        ) : (
          <div className={styles.btnRow}>
            <button onClick={() => setConfirm('lookup')}>刷新营销状态…</button>
          </div>
        )}
        {lookup && (
          <>
            <div className={styles.metrics}>
              <Metric label="匹配" value={lookup.summary.matched} tone="ok" />
              <Metric label="未找到" value={lookup.summary.notFound} />
              <Metric label="失败" value={lookup.summary.failed} tone="neg" />
              <Metric label="可营销" value={lookup.summary.mailable} tone="ok" />
            </div>
            <div className={styles.hint}>
              共 {int(lookup.summary.total)} 位 · 待确认 {int(lookup.summary.pending)} 位。只有「匹配 + 明确订阅 + 能接收 + 未抑制」才会进入可营销集合。
            </div>
            {lookup.summary.failed > 0 && <div className={styles.warn}>有 {int(lookup.summary.failed)} 位查询失败：失败不等于成功，他们不会进入可营销集合。</div>}
          </>
        )}
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitle}>用于邮件设计</div>
        <div className={styles.hint}>保存「模板 + 受众」的本地准备记录并打开设计器；只写本地记录，不发送邮件，也不推送模板。</div>
        {!snapshotFresh ? (
          <div className={styles.hint}>请先保存当前范围的受众快照。</div>
        ) : (
          <div className={styles.btnRow}>
            <button onClick={() => void openPrepare()} disabled={busy === 'templates'}>
              {prepareOpen ? '重新载入模板列表' : '用于邮件设计…'}
            </button>
            {prepareOpen && (
              <>
                <select className={styles.select} value={templateChoice} onChange={(e) => setTemplateChoice(e.target.value)}>
                  <option value="">选择模板…</option>
                  {(templates ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                  <option value={NEW_TEMPLATE}>新建模板…</option>
                </select>
                {templateChoice === NEW_TEMPLATE ? (
                  <>
                    <input
                      className={styles.input}
                      value={newTemplateName}
                      placeholder="新模板名称"
                      maxLength={120}
                      onChange={(e) => setNewTemplateName(e.target.value)}
                    />
                    <button className={styles.btnPrimary} disabled={!newTemplateName.trim() || busy === 'prepare'} onClick={() => void createTemplateAndSave()}>
                      新建并使用
                    </button>
                  </>
                ) : (
                  <button className={styles.btnPrimary} disabled={!templateChoice || busy === 'prepare'} onClick={() => void savePreparationFor(templateChoice)}>
                    {busy === 'prepare' ? '保存中…' : '保存准备记录并打开设计器'}
                  </button>
                )}
              </>
            )}
          </div>
        )}
        {prepareOpen && templates?.length === 0 && <div className={styles.hint}>模板库还是空的，选择「新建模板…」即可。</div>}
        {templatesError && <div className={styles.danger}>模板列表读取失败：{templatesError}</div>}
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitle}>同步客户资料（不订阅、不加名单）</div>
        <div className={styles.hint}>
          把白名单运营字段写入已匹配的 Klaviyo Profile；不附带订阅操作，创建或更新资料都不代表用户同意营销。
        </div>
        {profileBlockedReason ? (
          <>
            <button disabled>同步客户资料</button>
            <div className={styles.hint}>不可用：{profileBlockedReason}</div>
          </>
        ) : !snapshotFresh ? (
          <>
            <button disabled>同步客户资料</button>
            <div className={styles.hint}>不可用：请先保存当前范围的受众快照。</div>
          </>
        ) : !profileOpen ? (
          <div className={styles.btnRow}>
            <button
              onClick={() => {
                setProfileOpen(true);
                void runProfilePreflight();
              }}
            >
              同步客户资料…
            </button>
          </div>
        ) : (
          <>
            <div className={styles.options}>
              {PROFILE_FIELDS.map((f) => (
                <label key={f.key} className={styles.option}>
                  <input
                    type="checkbox"
                    checked={profileFields.includes(f.key)}
                    onChange={() =>
                      setProfileFields((prev) => (prev.includes(f.key) ? prev.filter((k) => k !== f.key) : [...prev, f.key]))
                    }
                  />
                  {f.label}
                </label>
              ))}
            </div>
            <div className={styles.fieldRow}>
              <span className={styles.hint}>货币单位（推送 ops_ltv 前必须确认）</span>
              <input
                className={styles.input}
                value={profileCurrency}
                placeholder="例如 USD"
                maxLength={8}
                onChange={(e) => setProfileCurrency(e.target.value)}
              />
              <button onClick={() => void runProfilePreflight()} disabled={busy === 'preflightProfile' || ltvNeedsCurrency || profileFields.length === 0}>
                {busy === 'preflightProfile' ? '预检中…' : profilePreflight ? '重新预检' : '预检'}
              </button>
            </div>
            {profileFields.length === 0 && <div className={styles.warn}>请至少选择一个要同步的字段。</div>}
            {ltvNeedsCurrency && <div className={styles.warn}>勾选了 ops_ltv：必须先确认货币单位，无法核实的金额不上传。</div>}
            {profilePreflight && (
              <div className={styles.confirm}>
                <div className={styles.confirmHead}>
                  资料同步预检结果{profilePreflightFresh ? '' : '（字段 / 货币 / 受众已变化，需重新预检）'}
                </div>
                <PreflightMessages result={profilePreflight} />
                <div className={styles.confirmGrid}>
                  <span className={styles.confirmK}>账号</span>
                  <span className={styles.confirmV}>{summaryAccount(profilePreflight.summary, accountLabel, accountId)}</span>
                  <span className={styles.confirmK}>店铺</span>
                  <span className={styles.confirmV}>{summaryStr(profilePreflight.summary.storeKey) || '未知'}</span>
                  <span className={styles.confirmK}>范围</span>
                  <span className={styles.confirmV}>
                    {summaryStr(profilePreflight.summary.scopeLabel) || (snapshot.mode === 'ids' ? '勾选用户' : '当前筛选结果')} · 快照{' '}
                    <code className={styles.mono}>{snapshot.id}</code>
                  </span>
                  <span className={styles.confirmK}>总人数</span>
                  <span className={styles.confirmV}>{countText(profilePreflight.summary.total)}</span>
                  <span className={styles.confirmK}>将写入人数</span>
                  <span className={styles.confirmV}>{countText(profilePreflight.summary.willCreateOrUpdate)}</span>
                  <span className={styles.confirmK}>已匹配资料</span>
                  <span className={styles.confirmV}>{countText(profilePreflight.summary.alreadyMapped)}</span>
                  <span className={styles.confirmK}>将发送的字段</span>
                  <span className={styles.confirmV}>{fieldCodesText(profilePreflight.summary.fields)}</span>
                  <span className={styles.confirmK}>货币</span>
                  <span className={styles.confirmV}>{summaryStr(profilePreflight.summary.currency) || '未确认'}</span>
                </div>
                <div className={styles.warn}>不订阅、不加名单、不取消抑制；创建或更新资料不代表用户同意营销。</div>
                <div className={styles.confirmActions}>
                  <button
                    className={styles.btnPrimary}
                    onClick={() => void runProfileSync()}
                    disabled={!profileConfirmReady || busy === 'profileSync' || ltvNeedsCurrency}
                  >
                    {busy === 'profileSync' ? '同步中…' : '确认同步资料'}
                  </button>
                  <button onClick={() => setProfileOpen(false)}>收起</button>
                </div>
                {!profileConfirmReady && <div className={styles.hint}>预检未通过或条件已变化：请先重新预检，预检通过后才能同步。</div>}
                <div className={styles.hint}>这次确认只覆盖本次账号 / 字段 / 范围，不是长期授权。</div>
              </div>
            )}
          </>
        )}
      </div>

      <div className={styles.block}>
        <div className={styles.blockTitle}>同步到 Klaviyo 名单</div>
        {syncBlockedReason ? (
          <>
            <button disabled>同步到 Klaviyo 名单</button>
            <div className={styles.hint}>不可用：{syncBlockedReason}</div>
          </>
        ) : !snapshotFresh ? (
          <>
            <button disabled>同步到 Klaviyo 名单</button>
            <div className={styles.hint}>不可用：请先保存当前范围的受众快照。</div>
          </>
        ) : confirm !== 'listSync' ? (
          <>
            <div className={styles.btnRow}>
              <button
                onClick={() => {
                  setConfirm('listSync');
                  void runListPreflight();
                }}
              >
                同步到 Klaviyo 名单…
              </button>
            </div>
            <div className={styles.hint}>
              只增加名单成员（不删除远端成员、不修改订阅状态）。打开后会先预检账号、店铺、名单、受众与规则，通过后才能确认。
            </div>
          </>
        ) : (
          <div className={styles.confirm}>
            <div className={styles.confirmHead}>确认同步名单（本次操作单独确认）</div>
            {busy === 'preflightList' && !listPreflight && <div className={styles.hint}>预检中…（正在核对账号、店铺、名单、受众与订阅规则）</div>}
            {!listPreflight && busy !== 'preflightList' && <div className={styles.hint}>还没有预检结果，请点击「重新预检」。</div>}
            {listPreflight && (
              <>
                <PreflightMessages result={listPreflight} />
                <div className={styles.confirmGrid}>
                  <span className={styles.confirmK}>账号</span>
                  <span className={styles.confirmV}>{summaryAccount(listPreflight.summary, accountLabel, accountId)}</span>
                  <span className={styles.confirmK}>店铺</span>
                  <span className={styles.confirmV}>{summaryStr(listPreflight.summary.storeKey) || storeKey || '未知'}</span>
                  <span className={styles.confirmK}>目标名单</span>
                  <span className={styles.confirmV}>
                    {summaryStr(listPreflight.summary.listName) || listName || '未命名名单'}（
                    <code className={styles.mono}>{summaryStr(listPreflight.summary.listId) || listId || '未配置'}</code>）
                  </span>
                  <span className={styles.confirmK}>范围</span>
                  <span className={styles.confirmV}>
                    {summaryStr(listPreflight.summary.scopeLabel) || (snapshot.mode === 'ids' ? '勾选用户' : '当前筛选结果')} · 快照{' '}
                    <code className={styles.mono}>{snapshot.id}</code>
                  </span>
                  <span className={styles.confirmK}>总人数</span>
                  <span className={styles.confirmV}>{countText(listPreflight.summary.total)}</span>
                  <span className={styles.confirmK}>将提交人数</span>
                  <span className={styles.confirmV}>{countText(listPreflight.summary.willSubmit)}</span>
                  <span className={styles.confirmK}>按规则排除人数</span>
                  <span className={styles.confirmV}>
                    {countText(listPreflight.summary.excludedByRule)}
                    {snapshot.excluded.length
                      ? `（${snapshot.excluded.map((x) => `${EXCLUSION_TEXT[x.reason] ?? x.reason} ${x.count} 人`).join('；')}）`
                      : ''}
                  </span>
                  <span className={styles.confirmK}>将发送的字段</span>
                  <span className={styles.confirmV}>{SYNC_FIELDS}</span>
                </div>
                {!listPreflightFresh && <div className={styles.warn}>快照 / 目标名单已变化：这个预检结果和 confirm 已失效，必须重新预检。</div>}
                <div className={styles.warn}>只增加名单成员，不做全量覆盖；不修改订阅 / 抑制状态；加入名单不代表用户同意营销。</div>
                {statusRefreshedFor !== snapshot.id && <div className={styles.warn}>执行前必须先刷新订阅状态：请先完成上面的「刷新营销状态」。</div>}
                <div className={styles.confirmActions}>
                  <button
                    className={styles.btnPrimary}
                    onClick={() => void runListSync()}
                    disabled={!listConfirmReady || busy === 'sync' || statusRefreshedFor !== snapshot.id}
                  >
                    {busy === 'sync' ? '同步中…' : '确认同步名单'}
                  </button>
                  <button onClick={() => void runListPreflight()} disabled={busy === 'preflightList'}>
                    {busy === 'preflightList' ? '预检中…' : '重新预检'}
                  </button>
                  <button onClick={() => setConfirm(null)}>取消</button>
                </div>
                <div className={styles.hint}>
                  confirm 串由服务端预检签发并绑定 (目标名单, 快照, 受众指纹)，范围变化后必须重新预检；这次确认不是长期授权。
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {notice && <div className={notice.ok ? styles.noticeOk : styles.noticeErr}>{notice.text}</div>}
    </div>
  );
}