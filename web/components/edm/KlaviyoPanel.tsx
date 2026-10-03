'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatDateTime } from '@/components/customer-marketing/MarketingStatusTag';
import { errorText, readApiError } from '@/components/customer-marketing/useMarketingStatus';
import type { Operation, OperationKind, OperationStatus, StepStatus } from '@/lib/edm/types';
import { int } from '@/lib/format';
import styles from './designer.module.css';

// Klaviyo 面板：连接状态（只读）→ 推送已冻结的模板版本 → 从远端导入模板 →
// 受众相关的两个独立写入（同步客户资料 / 加入名单）→ 执行记录与显式恢复。
// 三条写入路径各自预检、各自确认；本面板不创建 Campaign、不发送邮件，也不修改订阅状态。

type IntegrationStatus = {
  configured: boolean;
  keyMask: string;
  account: { id: string | null; label: string } | null;
  apiRevision: string;
  storeKey: string;
  writesEnabled: boolean;
  writesEnabledByEnv: boolean;
  writesEnabledByBinding: boolean;
  defaultListId: string | null;
  defaultListName: string;
  lastCheck: { ok: boolean; detail: string } | null;
  lastCheckedAt: string | null;
  /** 操作员身份脱敏视图；旧响应可能没有这个字段，缺失时按未验证处理 */
  access?: {
    operatorVerified: boolean;
    note: string;
  };
};

type RemoteTemplate = {
  id: string;
  name: string;
  editorType: string | null;
  html: string | null;
  created: string | null;
  updated: string | null;
};

type RemoteList = { id: string; name: string; profileCount: number | null; fetchedAt: string };

/** POST /api/integrations/klaviyo/preflight 的响应；confirm 必须原样回传给对应的 sync */
type PreflightResponse = {
  ok: boolean;
  blockers: string[];
  warnings: string[];
  summary: Record<string, unknown>;
  confirm: string;
};

type ProfileField =
  | 'ops_customer_ref'
  | 'ops_segment'
  | 'ops_tags'
  | 'ops_orders'
  | 'ops_ltv'
  | 'ops_currency'
  | 'ops_last_order_at';

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
const DEFAULT_PROFILE_FIELDS: ProfileField[] = [
  'ops_customer_ref',
  'ops_segment',
  'ops_tags',
  'ops_orders',
  'ops_last_order_at',
];

const KIND_LABELS: Record<OperationKind, string> = {
  template_sync: '模板推送',
  image_upload: '素材上传',
  profile_sync: '资料同步',
  list_sync: '名单同步',
};

/** 成功文案只描述已发生的事实：模板同步 / 资料同步 / 名单更新，绝不写「发送成功」 */
const KIND_OK_LABELS: Record<OperationKind, string> = {
  template_sync: '模板已同步',
  image_upload: '素材已上传',
  profile_sync: '资料已同步',
  list_sync: '名单已更新',
};

const STATUS_LABELS: Record<OperationStatus, string> = {
  pending: '排队中',
  running: '执行中',
  done: '已完成',
  partial: '部分完成',
  failed: '失败',
  unknown: '结果不明',
  awaiting_resume: '待继续',
};

const STEP_LABELS: Record<StepStatus, string> = { ok: '成功', skip: '跳过', fail: '失败', unknown: '结果不明' };

function statusClass(status: OperationStatus): string {
  if (status === 'done') return styles.badgeGreen;
  if (status === 'pending' || status === 'running') return styles.badge;
  if (status === 'failed') return styles.statusBad;
  return styles.statusWarn;
}

function summaryStr(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v : '';
}

function summaryNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function countText(v: unknown): string {
  const n = summaryNum(v);
  return n === null ? '未知' : `${int(n)} 人`;
}

function numText(v: unknown, unit: string): string {
  const n = summaryNum(v);
  return n === null ? '未知' : `${int(n)} ${unit}`;
}

function fieldCodesText(v: unknown): string {
  if (!Array.isArray(v) || v.length === 0) return '未选择';
  return v.map((x) => String(x)).join('、');
}

/** 预检 summary 里的「账号」展示：读不到就用本地绑定兜底，仍读不到显示未知，不猜 */
function summaryAccount(s: Record<string, unknown>, fallbackLabel: string, fallbackId: string | null): string {
  const id = summaryStr(s.account) || fallbackId || '';
  const label = summaryStr(s.accountLabel) || fallbackLabel;
  if (label && id) return `${label}（${id}）`;
  return label || id || '未知';
}

function remoteTemplateText(s: Record<string, unknown>): string {
  const id = summaryStr(s.remoteId);
  if (!id) return '将新建远端 CODE 模板（本地模板尚未绑定远端模板）';
  const type = summaryStr(s.remoteEditorType);
  const updated = summaryStr(s.remoteUpdated);
  return [id, type ? `类型 ${type}` : '', updated ? `远端更新 ${formatDateTime(updated)}` : ''].filter(Boolean).join(' · ');
}

/** 执行结果文案：失败、结果不明、部分完成都不算成功 */
function operationNotice(op: Operation | null | undefined, okLabel: string, failLabel: string): { ok: boolean; text: string } {
  if (!op) return { ok: true, text: `${okLabel}（服务端未返回执行记录，请在执行记录中核对）` };
  const tail = [op.summary, op.id ? `执行记录 ${op.id}` : ''].filter(Boolean).join(' · ');
  if (op.status === 'failed') return { ok: false, text: `${failLabel}：${tail}` };
  if (op.status === 'unknown') return { ok: false, text: `提交结果不明，不要盲目重试：${tail}。请先到 Klaviyo 核对再决定` };
  if (op.status === 'partial' || op.status === 'awaiting_resume') {
    return { ok: false, text: `部分完成：${tail}${op.resumable ? '（仍有待处理项，核对后可在执行记录里继续）' : ''}` };
  }
  if (op.status !== 'done') return { ok: false, text: `执行状态 ${STATUS_LABELS[op.status]}：${tail}` };
  return { ok: true, text: `${okLabel}：${tail}` };
}

/** 预检的 blockers（阻止提交）与 warnings（提醒但不阻止） */
function PreflightMessages({ result }: { result: PreflightResponse }): React.ReactElement {
  return (
    <>
      {result.blockers.length > 0 && (
        <div className={styles.errBox}>
          预检未通过，已阻止提交：
          <ul>
            {result.blockers.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </div>
      )}
      {result.warnings.length > 0 && (
        <div className={styles.warnBox}>
          提醒（不阻止提交）：
          <ul>
            {result.warnings.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function OperationResult({ op }: { op: Operation }): React.ReactElement {
  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>
        最近一次写入结果：{KIND_LABELS[op.kind]} · <span className={statusClass(op.status)}>{STATUS_LABELS[op.status]}</span>
      </div>
      <div className={styles.kvGrid}>
        <span className={styles.kvK}>摘要</span>
        <span className={styles.kvV}>{op.summary || '（无摘要）'}</span>
        <span className={styles.kvK}>执行记录</span>
        <span className={styles.kvV}>
          <code className={styles.mono}>{op.id}</code>
        </span>
        <span className={styles.kvK}>更新时间</span>
        <span className={styles.kvV}>{formatDateTime(op.updatedAt)}</span>
      </div>
      {op.steps.length === 0 ? (
        <div className={styles.muted}>没有步骤明细。</div>
      ) : (
        op.steps.map((s, i) => (
          <div key={`${s.name}-${i}`} className={styles.stepItem}>
            <span className={styles.versionMeta}>{formatDateTime(s.at)}</span>
            <b>{s.name}</b>
            <span className={styles.versionMeta}>
              {STEP_LABELS[s.status]}
              {s.count !== null ? ` · ${int(s.count)}` : ''}
            </span>
            <span>{s.detail}</span>
          </div>
        ))
      )}
      {op.status !== 'done' && (
        <div className={styles.warnBox}>
          该结果不代表成功；结果不明时不要重复提交，请先到 Klaviyo 核对，再在执行记录里决定是否继续。
        </div>
      )}
    </div>
  );
}

export function KlaviyoPanel(props: {
  open: boolean;
  onClose: () => void;
  templateId: string;
  versionId: string;
  dirty: boolean;
  audienceId: string | null;
}): React.ReactElement {
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [lastResult, setLastResult] = useState<Operation | null>(null);

  const [remoteTemplates, setRemoteTemplates] = useState<RemoteTemplate[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [imported, setImported] = useState<{ id: string; name: string } | null>(null);

  const [onConflict, setOnConflict] = useState<'fail' | 'new'>('fail');
  const [tplPreflight, setTplPreflight] = useState<PreflightResponse | null>(null);
  const [tplPreflightFor, setTplPreflightFor] = useState<string | null>(null);
  const tplSeq = useRef(0);

  const [profileOpen, setProfileOpen] = useState(false);
  const [profileFields, setProfileFields] = useState<ProfileField[]>(DEFAULT_PROFILE_FIELDS);
  const [profileCurrency, setProfileCurrency] = useState('');
  const [profilePreflight, setProfilePreflight] = useState<PreflightResponse | null>(null);
  const [profilePreflightFor, setProfilePreflightFor] = useState<string | null>(null);
  const profileSeq = useRef(0);

  const [lists, setLists] = useState<RemoteList[] | null>(null);
  const [listsError, setListsError] = useState<string | null>(null);
  const [listId, setListId] = useState('');
  const [listPreflight, setListPreflight] = useState<PreflightResponse | null>(null);
  const [listPreflightFor, setListPreflightFor] = useState<string | null>(null);
  const listSeq = useRef(0);

  const [operations, setOperations] = useState<Operation[] | null>(null);
  const [operationsError, setOperationsError] = useState<string | null>(null);

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/integrations/klaviyo/status');
      if (!res.ok) throw new Error(await readApiError(res));
      const data = (await res.json()) as IntegrationStatus;
      setStatus(data);
      setStatusError(null);
    } catch (e) {
      setStatusError(errorText(e, 'Klaviyo 连接状态读取失败'));
    }
  }, []);

  const loadOperations = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/integrations/klaviyo/operations');
      if (!res.ok) throw new Error(await readApiError(res));
      const data = (await res.json()) as { operations: Operation[] };
      setOperations(Array.isArray(data.operations) ? data.operations : []);
      setOperationsError(null);
    } catch (e) {
      setOperationsError(errorText(e, '执行记录读取失败'));
    }
  }, []);

  const loadLists = useCallback(async (): Promise<void> => {
    setBusy('lists');
    try {
      const res = await fetch('/api/integrations/klaviyo/lists');
      if (!res.ok) throw new Error(await readApiError(res));
      const data = (await res.json()) as { lists: RemoteList[] };
      setLists(Array.isArray(data.lists) ? data.lists : []);
      setListsError(null);
    } catch (e) {
      setListsError(errorText(e, '名单列表读取失败'));
    } finally {
      setBusy((b) => (b === 'lists' ? null : b));
    }
  }, []);

  const loadRemoteTemplates = useCallback(async (): Promise<void> => {
    setBusy('templates');
    try {
      const res = await fetch('/api/integrations/klaviyo/templates');
      if (!res.ok) throw new Error(await readApiError(res));
      const data = (await res.json()) as { templates: RemoteTemplate[] };
      setRemoteTemplates(Array.isArray(data.templates) ? data.templates : []);
      setTemplatesError(null);
    } catch (e) {
      setTemplatesError(errorText(e, '远端模板读取失败'));
    } finally {
      setBusy((b) => (b === 'templates' ? null : b));
    }
  }, []);

  useEffect(() => {
    if (!props.open) return;
    // 打开时读取连接状态与执行记录：两者都是只读，写入开关关闭时也可以使用
    void loadStatus();
    void loadOperations();
  }, [props.open, loadStatus, loadOperations]);

  // 默认选中设置页配置的目标名单（可再手动改）
  useEffect(() => {
    if (!status) return;
    setListId((prev) => prev || status.defaultListId || '');
  }, [status]);

  // 写入是否可用：任一条件缺失都要指出具体缺哪一项
  const writeBlockReason = useMemo((): string | null => {
    if (statusError) return '无法确认 Klaviyo 连接状态（状态读取失败）';
    if (!status) return '正在读取 Klaviyo 连接状态…';
    if (status.writesEnabled) return null;
    if (!status.configured) return '未配置私钥（服务端环境变量 KLAVIYO_PRIVATE_API_KEY）';
    if (!status.writesEnabledByEnv) return '服务端写入开关未开启（KLAVIYO_ENABLE_WRITES 不是 true）';
    if (!status.writesEnabledByBinding) return '设置页的「允许真实写入」未开启';
    if (!(status.access?.operatorVerified ?? false)) {
      return `操作员身份未验证${status.access?.note ? `：${status.access.note}` : '（真实写入只允许本机、可信上游网关或显式令牌）'}`;
    }
    return '写入开关当前不可用';
  }, [status, statusError]);
  const writesReady = writeBlockReason === null;

  const audienceId = props.audienceId;

  // 受众写入可用时，自动读取一次远端名单（失败不自动重试，交由「刷新名单列表」按钮）
  const listsRequested = useRef(false);
  useEffect(() => {
    if (!props.open || !audienceId || !writesReady) return;
    if (lists !== null || listsRequested.current) return;
    listsRequested.current = true;
    void loadLists();
  }, [props.open, audienceId, writesReady, lists, loadLists]);

  const templateKey = `${props.templateId}|${props.versionId}|${onConflict}`;
  const tplFresh = tplPreflight !== null && tplPreflightFor === templateKey;
  const tplReady = tplFresh && tplPreflight.ok;

  const tplSeqInvalidate = (): void => {
    tplSeq.current += 1;
    setTplPreflight(null);
    setTplPreflightFor(null);
    setBusy((b) => (b === 'preflightTemplate' ? null : b));
  };

  // 换了模板或版本：旧预检与 confirm 立即作废，绝不复用
  useEffect(() => {
    tplSeq.current += 1;
    setTplPreflight(null);
    setTplPreflightFor(null);
    setBusy((b) => (b === 'preflightTemplate' ? null : b));
  }, [props.templateId, props.versionId]);

  const profileCurrencyValue = profileCurrency.trim().toUpperCase();
  const profileKey = audienceId
    ? `${audienceId}|${[...profileFields].sort().join(',')}|${profileCurrencyValue}`
    : null;
  const profileFresh = profilePreflight !== null && profileKey !== null && profilePreflightFor === profileKey;
  const profileReady = profileFresh && profilePreflight.ok;
  const ltvNeedsCurrency = profileFields.includes('ops_ltv') && !profileCurrencyValue;

  const listKey = audienceId && listId ? `${audienceId}|${listId}` : null;
  const listFresh = listPreflight !== null && listKey !== null && listPreflightFor === listKey;
  const listReady = listFresh && listPreflight.ok;

  // 受众变化：两种写入的旧预检与 confirm 全部作废
  useEffect(() => {
    profileSeq.current += 1;
    listSeq.current += 1;
    setProfilePreflight(null);
    setProfilePreflightFor(null);
    setListPreflight(null);
    setListPreflightFor(null);
    setBusy((b) => (b === 'preflightProfile' || b === 'preflightList' ? null : b));
  }, [audienceId]);

  /** 模板推送预检：不写入，只核对账号 / 店铺 / 版本 / 素材 / 语法并签发 confirm 串 */
  const runTemplatePreflight = async (conflict: 'fail' | 'new' = onConflict): Promise<void> => {
    if (props.dirty) {
      setNotice({ ok: false, text: '未保存的改动不能推送，请先保存为新版本' });
      return;
    }
    const mine = ++tplSeq.current;
    const key = `${props.templateId}|${props.versionId}|${conflict}`;
    setBusy('preflightTemplate');
    setNotice(null);
    try {
      const res = await fetch('/api/integrations/klaviyo/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'template',
          templateId: props.templateId,
          versionId: props.versionId,
          onConflict: conflict,
        }),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      const data = (await res.json()) as PreflightResponse;
      if (mine !== tplSeq.current) return;
      setTplPreflight(data);
      setTplPreflightFor(key);
    } catch (e) {
      if (mine !== tplSeq.current) return;
      setTplPreflight(null);
      setTplPreflightFor(null);
      setNotice({ ok: false, text: errorText(e, '模板推送预检失败') });
    } finally {
      if (mine === tplSeq.current) setBusy((b) => (b === 'preflightTemplate' ? null : b));
    }
  };

  /** 「另存为新模板」切换：旧 confirm 立即作废，并已做过预检时用新策略重跑一次 */
  const changeConflict = async (next: 'fail' | 'new'): Promise<void> => {
    const hadPreflight = tplPreflightFor !== null;
    setOnConflict(next);
    tplSeqInvalidate();
    if (hadPreflight && !props.dirty) await runTemplatePreflight(next);
  };

  const runTemplateSync = async (): Promise<void> => {
    if (!tplPreflight || !tplFresh || !tplPreflight.ok) {
      setNotice({ ok: false, text: '请先完成预检并确认账号、店铺、模板与版本' });
      return;
    }
    setBusy('syncTemplate');
    setNotice(null);
    try {
      const res = await fetch('/api/integrations/klaviyo/templates/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // confirm 必须原样回传预检签发的串；它绑定模板与版本 hash
        body: JSON.stringify({
          templateId: props.templateId,
          versionId: props.versionId,
          onConflict,
          confirm: tplPreflight.confirm,
        }),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      const data = (await res.json()) as { operation: Operation };
      setLastResult(data.operation);
      const n = operationNotice(data.operation, '模板已同步', '模板推送失败');
      setNotice(
        n.ok
          ? { ok: true, text: `${n.text}。模板同步只写入远端模板内容，不会创建 Campaign，也不会发送邮件。` }
          : n,
      );
      // confirm 已被消费：作废旧预检，避免重复推送
      tplSeqInvalidate();
      await loadOperations();
    } catch (e) {
      setNotice({ ok: false, text: errorText(e, '模板推送失败') });
    } finally {
      setBusy(null);
    }
  };

  const importTemplate = async (remote: RemoteTemplate): Promise<void> => {
    setBusy(`import:${remote.id}`);
    setNotice(null);
    setImported(null);
    try {
      const res = await fetch('/api/integrations/klaviyo/templates/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remoteId: remote.id }),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      const data = (await res.json()) as { template: { id: string; name: string } };
      setImported({ id: data.template.id, name: data.template.name });
    } catch (e) {
      setNotice({ ok: false, text: errorText(e, '模板导入失败') });
    } finally {
      setBusy((b) => (b && b.startsWith('import:') ? null : b));
    }
  };

  /** 资料同步预检：字段与货币确认后才能签发 confirm 串 */
  const runProfilePreflight = async (): Promise<void> => {
    if (!audienceId) return;
    const mine = ++profileSeq.current;
    const currency = profileCurrency.trim().toUpperCase();
    const key = `${audienceId}|${[...profileFields].sort().join(',')}|${currency}`;
    setBusy('preflightProfile');
    setNotice(null);
    try {
      const res = await fetch('/api/integrations/klaviyo/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'profile', audienceId, fields: profileFields, currency: currency || null }),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      const data = (await res.json()) as PreflightResponse;
      if (mine !== profileSeq.current) return;
      setProfilePreflight(data);
      setProfilePreflightFor(key);
    } catch (e) {
      if (mine !== profileSeq.current) return;
      setProfilePreflight(null);
      setProfilePreflightFor(null);
      setNotice({ ok: false, text: errorText(e, '资料同步预检失败') });
    } finally {
      if (mine === profileSeq.current) setBusy((b) => (b === 'preflightProfile' ? null : b));
    }
  };

  const runProfileSync = async (): Promise<void> => {
    if (!audienceId || !profilePreflight || !profileReady) {
      setNotice({ ok: false, text: '请先完成预检并确认字段与货币' });
      return;
    }
    const currency = profileCurrency.trim().toUpperCase() || null;
    setBusy('syncProfile');
    setNotice(null);
    try {
      const res = await fetch('/api/integrations/klaviyo/profiles/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audienceId, fields: profileFields, currency, confirm: profilePreflight.confirm }),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      const data = (await res.json()) as { operation: Operation };
      setLastResult(data.operation);
      const n = operationNotice(data.operation, KIND_OK_LABELS.profile_sync, '资料同步失败');
      setNotice(
        n.ok
          ? {
              ok: true,
              text: `${n.text}（不订阅、不加名单、不取消抑制；创建或更新资料不代表用户同意营销）`,
            }
          : n,
      );
      profileSeq.current += 1;
      setProfilePreflight(null);
      setProfilePreflightFor(null);
      await loadOperations();
    } catch (e) {
      setNotice({ ok: false, text: errorText(e, '资料同步失败') });
    } finally {
      setBusy(null);
    }
  };

  /** 名单同步预检：不写入，只核对账号 / 店铺 / 名单 / 受众并签发 confirm 串 */
  const runListPreflight = async (): Promise<void> => {
    if (!audienceId || !listId) return;
    const mine = ++listSeq.current;
    const key = `${audienceId}|${listId}`;
    setBusy('preflightList');
    setNotice(null);
    try {
      const res = await fetch('/api/integrations/klaviyo/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'list', audienceId, listId }),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      const data = (await res.json()) as PreflightResponse;
      if (mine !== listSeq.current) return;
      setListPreflight(data);
      setListPreflightFor(key);
    } catch (e) {
      if (mine !== listSeq.current) return;
      setListPreflight(null);
      setListPreflightFor(null);
      setNotice({ ok: false, text: errorText(e, '名单同步预检失败') });
    } finally {
      if (mine === listSeq.current) setBusy((b) => (b === 'preflightList' ? null : b));
    }
  };

  const runListSync = async (): Promise<void> => {
    if (!audienceId || !listId || !listPreflight || !listReady) {
      setNotice({ ok: false, text: '请先完成预检并确认账号、店铺、名单与范围' });
      return;
    }
    setBusy('syncList');
    setNotice(null);
    try {
      const res = await fetch('/api/integrations/klaviyo/lists/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audienceId, listId, confirm: listPreflight.confirm }),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      const data = (await res.json()) as { operation: Operation };
      setLastResult(data.operation);
      const n = operationNotice(data.operation, KIND_OK_LABELS.list_sync, '名单同步失败');
      setNotice(
        n.ok
          ? { ok: true, text: `${n.text}。只增加名单成员；加入名单不代表用户同意营销，也不代表邮件已发送。` }
          : n,
      );
      listSeq.current += 1;
      setListPreflight(null);
      setListPreflightFor(null);
      await loadOperations();
    } catch (e) {
      setNotice({ ok: false, text: errorText(e, '名单同步失败') });
    } finally {
      setBusy(null);
    }
  };

  const resumeOperation = async (op: Operation): Promise<void> => {
    const confirmed = window.confirm(
      `继续执行记录 ${op.id}？\n\n继续会按记录里的待处理项再次向 Klaviyo 提交，可能产生重复或部分结果；请先到 Klaviyo 核对当前状态再决定。\n\n这次确认只覆盖这一条执行记录，不是长期授权。`,
    );
    if (!confirmed) return;
    setBusy(`resume:${op.id}`);
    setNotice(null);
    try {
      const res = await fetch(`/api/integrations/klaviyo/operations/${encodeURIComponent(op.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resume' }),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      const data = (await res.json()) as { operation: Operation };
      setLastResult(data.operation);
      setOperations((prev) =>
        prev ? prev.map((x) => (x.id === data.operation.id ? data.operation : x)) : prev,
      );
      setNotice(operationNotice(data.operation, KIND_OK_LABELS[data.operation.kind], '继续执行失败'));
      await loadOperations();
    } catch (e) {
      setNotice({ ok: false, text: errorText(e, '继续执行失败') });
    } finally {
      setBusy((b) => (b && b.startsWith('resume:') ? null : b));
    }
  };

  if (!props.open) return <></>;

  const accountText = status?.account
    ? `${status.account.label || '未命名账号'}（${status.account.id ?? '未返回账号 ID'}）`
    : '未核对（可在设置页测试连接）';

  return (
    <div className={styles.modalMask} onClick={props.onClose}>
      <div className={`${styles.modal} ${styles.modalWide}`} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <b>Klaviyo</b>
          <span className={styles.muted}>模板推送、远端导入与受众写入；三条写入路径各自预检、各自确认</span>
          <div className={styles.spacer} />
          <button className={styles.smallBtn} onClick={props.onClose}>
            关闭
          </button>
        </div>

        <div className={styles.modalBody}>
          <div className={styles.section}>
            <div className={styles.sectionTitle}>连接状态（只读，不创建任何资源）</div>
            {statusError && (
              <div className={styles.errBox}>
                {statusError}
                <div className={styles.rowActions}>
                  <button className={styles.smallBtn} onClick={() => void loadStatus()}>
                    重试
                  </button>
                </div>
              </div>
            )}
            {!status && !statusError && <div className={styles.muted}>连接状态读取中…</div>}
            {status && (
              <>
                <div className={styles.kvGrid}>
                  <span className={styles.kvK}>账号</span>
                  <span className={styles.kvV}>{accountText}</span>
                  <span className={styles.kvK}>API revision</span>
                  <span className={styles.kvV}>
                    <code className={styles.mono}>{status.apiRevision}</code>
                  </span>
                  <span className={styles.kvK}>店铺绑定</span>
                  <span className={styles.kvV}>
                    {status.storeKey ? <code className={styles.mono}>{status.storeKey}</code> : '未绑定（请先在设置页完成店铺绑定）'}
                  </span>
                  <span className={styles.kvK}>私钥状态</span>
                  <span className={styles.kvV}>
                    {status.configured ? (
                      <>
                        已配置 <span className={styles.badgeGreen}>脱敏 {status.keyMask || '••••••'}</span>
                        （私钥只存在服务端，不会下发到浏览器）
                      </>
                    ) : (
                      <>
                        未配置 <span className={styles.badge}>缺少 KLAVIYO_PRIVATE_API_KEY</span>
                      </>
                    )}
                  </span>
                  <span className={styles.kvK}>写入是否可用</span>
                  <span className={styles.kvV}>
                    {writesReady ? (
                      <span className={styles.badgeGreen}>可用</span>
                    ) : (
                      <>
                        <span className={styles.statusWarn}>不可用</span> {writeBlockReason}
                      </>
                    )}
                  </span>
                  <span className={styles.kvK}>最近检查</span>
                  <span className={styles.kvV}>
                    {status.lastCheckedAt
                      ? `${formatDateTime(status.lastCheckedAt)} · ${status.lastCheck ? (status.lastCheck.ok ? '成功' : '失败') : '无结果'}${status.lastCheck?.detail ? `：${status.lastCheck.detail}` : ''}`
                      : '还没有检查记录'}
                  </span>
                  <span className={styles.kvK}>默认目标名单</span>
                  <span className={styles.kvV}>
                    {status.defaultListId
                      ? `${status.defaultListName || '未命名名单'}（${status.defaultListId}）`
                      : '未配置'}
                  </span>
                </div>
                <div className={styles.muted}>
                  账号检查成功不代表拥有全部写权限；写权限以首次真实操作的结果为准，这里不做「已授权」的推断。
                </div>
              </>
            )}
          </div>

          <div className={styles.section}>
            <div className={styles.sectionTitle}>推送模板到 Klaviyo</div>
            <div className={styles.muted}>
              冻结当前已保存的模板版本，检查素材与模板语法后写入远端 CODE 模板；不会创建 Campaign，也不会发送邮件。
            </div>
            <div className={styles.kvGrid}>
              <span className={styles.kvK}>本地模板</span>
              <span className={styles.kvV}>
                <code className={styles.mono}>{props.templateId}</code>
              </span>
              <span className={styles.kvK}>版本</span>
              <span className={styles.kvV}>
                <code className={styles.mono}>{props.versionId}</code>
                {props.dirty ? <span className={styles.dirtyBadge}>未保存</span> : null}
              </span>
            </div>
            {props.dirty && (
              <div className={styles.warnBox}>未保存的改动不能推送，请先保存为新版本。推送只使用已经冻结的版本内容。</div>
            )}
            <div className={styles.rowActions}>
              <label className={styles.rowActions}>
                <input
                  type="checkbox"
                  checked={onConflict === 'new'}
                  disabled={props.dirty}
                  onChange={(e) => void changeConflict(e.target.checked ? 'new' : 'fail')}
                />
                远端已被修改时另存为新模板（不覆盖远端已有内容）
              </label>
              <div className={styles.spacer} />
              <button
                className={styles.smallBtn}
                disabled={props.dirty || busy === 'preflightTemplate'}
                onClick={() => void runTemplatePreflight()}
              >
                {busy === 'preflightTemplate' ? '预检中…' : tplPreflight ? '重新预检' : '预检'}
              </button>
            </div>

            {tplPreflight && (
              <>
                <div className={styles.sectionTitle}>
                  预检结果{tplFresh ? '' : '（版本或冲突策略已变化，需重新预检）'}
                </div>
                <PreflightMessages result={tplPreflight} />
                <div className={styles.kvGrid}>
                  <span className={styles.kvK}>账号</span>
                  <span className={styles.kvV}>
                    {summaryAccount(tplPreflight.summary, status?.account?.label ?? '', status?.account?.id ?? null)}
                  </span>
                  <span className={styles.kvK}>店铺</span>
                  <span className={styles.kvV}>{summaryStr(tplPreflight.summary.storeKey) || status?.storeKey || '未知'}</span>
                  <span className={styles.kvK}>模板名</span>
                  <span className={styles.kvV}>{summaryStr(tplPreflight.summary.templateName) || '未知'}</span>
                  <span className={styles.kvK}>版本</span>
                  <span className={styles.kvV}>
                    <code className={styles.mono}>{summaryStr(tplPreflight.summary.versionId) || props.versionId}</code>
                    {summaryStr(tplPreflight.summary.versionHash)
                      ? `（hash ${summaryStr(tplPreflight.summary.versionHash).slice(0, 8)}）`
                      : ''}
                  </span>
                  <span className={styles.kvK}>远端模板</span>
                  <span className={styles.kvV}>{remoteTemplateText(tplPreflight.summary)}</span>
                  <span className={styles.kvK}>待上传素材数</span>
                  <span className={styles.kvV}>
                    {numText(tplPreflight.summary.assetsPendingUpload, '张')}（模板引用 {numText(tplPreflight.summary.assets, '张')}）
                  </span>
                  <span className={styles.kvK}>检查错误数</span>
                  <span className={styles.kvV}>{numText(tplPreflight.summary.lintErrors, '个')}</span>
                </div>
                {tplPreflight.blockers.length > 0 && (
                  <div className={styles.muted}>预检未通过时「确认推送」保持停用；请先处理上面的阻断项。</div>
                )}
                {!tplFresh && (
                  <div className={styles.warnBox}>版本或「另存为新模板」选择已变化：旧预检结果与 confirm 已失效，请重新预检。</div>
                )}
                <div className={styles.rowActions}>
                  <button
                    className={styles.primaryBtn}
                    disabled={!tplReady || props.dirty || busy === 'syncTemplate'}
                    onClick={() => void runTemplateSync()}
                  >
                    {busy === 'syncTemplate' ? '推送中…' : '确认推送模板'}
                  </button>
                  <span className={styles.muted}>
                    确认串由服务端预检签发并绑定模板与版本 hash；版本或冲突策略变化后必须重新预检，不能复用。
                  </span>
                </div>
              </>
            )}
          </div>

          <div className={styles.section}>
            <div className={styles.sectionTitle}>从 Klaviyo 导入模板</div>
            <div className={styles.muted}>
              读取远端模板清单并创建 OPS 本地副本；导入只读远端，不会覆盖它，也不会自动建立「可以覆盖远端」的授权。
            </div>
            <div className={styles.rowActions}>
              <button className={styles.smallBtn} disabled={busy === 'templates'} onClick={() => void loadRemoteTemplates()}>
                {busy === 'templates' ? '读取中…' : remoteTemplates ? '重新读取远端模板' : '读取远端模板'}
              </button>
              {remoteTemplates && <span className={styles.muted}>共 {remoteTemplates.length} 个远端模板</span>}
            </div>
            {templatesError && <div className={styles.errBox}>远端模板读取失败：{templatesError}</div>}
            {remoteTemplates && remoteTemplates.length === 0 && (
              <div className={styles.muted}>远端账号下还没有模板。</div>
            )}
            {(remoteTemplates ?? []).map((t) => (
              <div key={t.id} className={styles.versionItem}>
                <div className={styles.versionHead}>
                  <b className={styles.versionNote}>{t.name || '（未命名）'}</b>
                  <span className={styles.badge}>{t.editorType || '类型未知'}</span>
                  <span className={styles.versionMeta}>
                    <code className={styles.mono}>{t.id}</code>
                  </span>
                  <div className={styles.spacer} />
                  <button
                    className={styles.smallBtn}
                    disabled={busy === `import:${t.id}`}
                    onClick={() => void importTemplate(t)}
                  >
                    {busy === `import:${t.id}` ? '导入中…' : '导入为本地副本'}
                  </button>
                </div>
                <div className={styles.versionMeta}>
                  {t.updated ? `远端更新：${formatDateTime(t.updated)}` : '远端未返回更新时间'}
                </div>
              </div>
            ))}
            {imported && (
              <div className={styles.infoBox}>
                新本地模板：{imported.name}（<code className={styles.mono}>{imported.id}</code>）。请到模板库（/edm）打开它；
                本面板不会自动跳转，远端模板也没有被改动。
              </div>
            )}
          </div>

          {!audienceId || !writesReady ? (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>受众相关的写入</div>
              {!audienceId ? (
                <div className={styles.infoBox}>
                  尚未绑定受众：请关闭本面板，在设计器顶部点击「受众」选择并确认受众。同步客户资料与加入名单只作用于已绑定的受众快照。
                </div>
              ) : (
                <div className={styles.warnBox}>写入不可用：{writeBlockReason}</div>
              )}
              <div className={styles.muted}>
                同步客户资料与加入名单是两个独立操作：各自预检、各自确认。它们都不订阅、不取消抑制；加入名单不代表用户同意营销。
              </div>
            </div>
          ) : (
            <>
              <div className={styles.section}>
                <div className={styles.sectionTitle}>同步客户资料（不订阅、不加名单）</div>
                <div className={styles.muted}>
                  把白名单运营字段写入已匹配的 Klaviyo Profile；创建或更新资料不代表用户同意营销，也不会改变订阅或抑制状态。
                </div>
                <div className={styles.kvGrid}>
                  <span className={styles.kvK}>受众快照</span>
                  <span className={styles.kvV}>
                    <code className={styles.mono}>{audienceId}</code>
                  </span>
                </div>
                {!profileOpen ? (
                  <div className={styles.rowActions}>
                    <button
                      className={styles.smallBtn}
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
                    <div className={styles.rowActions}>
                      {PROFILE_FIELDS.map((f) => (
                        <label key={f.key} className={styles.rowActions}>
                          <input
                            type="checkbox"
                            checked={profileFields.includes(f.key)}
                            onChange={() =>
                              setProfileFields((prev) =>
                                prev.includes(f.key) ? prev.filter((k) => k !== f.key) : [...prev, f.key],
                              )
                            }
                          />
                          {f.label}
                        </label>
                      ))}
                    </div>
                    <div className={styles.rowActions}>
                      <span className={styles.fieldLabel}>货币单位（推送 ops_ltv 前必须确认）</span>
                      <input
                        className={styles.textInput}
                        value={profileCurrency}
                        placeholder="例如 USD"
                        maxLength={8}
                        onChange={(e) => setProfileCurrency(e.target.value)}
                      />
                      <button
                        className={styles.smallBtn}
                        disabled={busy === 'preflightProfile' || ltvNeedsCurrency || profileFields.length === 0}
                        onClick={() => void runProfilePreflight()}
                      >
                        {busy === 'preflightProfile' ? '预检中…' : profilePreflight ? '重新预检' : '预检'}
                      </button>
                    </div>
                    {profileFields.length === 0 && <div className={styles.warnBox}>请至少选择一个要同步的字段。</div>}
                    {ltvNeedsCurrency && (
                      <div className={styles.warnBox}>勾选了 ops_ltv：必须先确认货币单位，无法核实的金额不上传。</div>
                    )}
                    {profilePreflight && (
                      <>
                        <div className={styles.sectionTitle}>
                          资料同步预检结果{profileFresh ? '' : '（字段 / 货币 / 受众已变化，需重新预检）'}
                        </div>
                        <PreflightMessages result={profilePreflight} />
                        <div className={styles.kvGrid}>
                          <span className={styles.kvK}>账号</span>
                          <span className={styles.kvV}>
                            {summaryAccount(profilePreflight.summary, status?.account?.label ?? '', status?.account?.id ?? null)}
                          </span>
                          <span className={styles.kvK}>店铺</span>
                          <span className={styles.kvV}>
                            {summaryStr(profilePreflight.summary.storeKey) || status?.storeKey || '未知'}
                          </span>
                          <span className={styles.kvK}>范围</span>
                          <span className={styles.kvV}>
                            {summaryStr(profilePreflight.summary.scopeLabel) || '当前筛选结果'} · 总{' '}
                            {countText(profilePreflight.summary.total)}
                          </span>
                          <span className={styles.kvK}>有效邮箱</span>
                          <span className={styles.kvV}>{countText(profilePreflight.summary.validEmail)}</span>
                          <span className={styles.kvK}>将写入人数</span>
                          <span className={styles.kvV}>
                            {countText(profilePreflight.summary.willCreateOrUpdate)}（已匹配资料{' '}
                            {countText(profilePreflight.summary.alreadyMapped)}）
                          </span>
                          <span className={styles.kvK}>将发送的字段</span>
                          <span className={styles.kvV}>{fieldCodesText(profilePreflight.summary.fields)}</span>
                          <span className={styles.kvK}>货币</span>
                          <span className={styles.kvV}>{summaryStr(profilePreflight.summary.currency) || '未确认'}</span>
                        </div>
                        <div className={styles.rowActions}>
                          <button
                            className={styles.primaryBtn}
                            disabled={!profileReady || ltvNeedsCurrency || busy === 'syncProfile'}
                            onClick={() => void runProfileSync()}
                          >
                            {busy === 'syncProfile' ? '同步中…' : '确认同步资料'}
                          </button>
                          <button className={styles.smallBtn} onClick={() => setProfileOpen(false)}>
                            收起
                          </button>
                          {!profileReady && (
                            <span className={styles.muted}>预检未通过或条件已变化时不能提交，请先重新预检。</span>
                          )}
                        </div>
                        <div className={styles.muted}>
                          不订阅、不加名单、不取消抑制；这次确认只覆盖本次账号 / 字段 / 受众，不是长期授权。
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>

              <div className={styles.section}>
                <div className={styles.sectionTitle}>加入 Klaviyo 名单（只增加成员）</div>
                <div className={styles.muted}>
                  只向所选名单增加符合本期订阅规则的成员：不删除远端已有成员，不做全量覆盖，不修改订阅 / 抑制状态。
                </div>
                <div className={styles.rowActions}>
                  <select className={styles.select} value={listId} onChange={(e) => setListId(e.target.value)}>
                    <option value="">选择目标名单…</option>
                    {(lists ?? []).map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name || l.id}
                        {l.profileCount !== null ? `（${int(l.profileCount)} 人）` : ''}
                      </option>
                    ))}
                  </select>
                  <button className={styles.smallBtn} disabled={busy === 'lists'} onClick={() => void loadLists()}>
                    {busy === 'lists' ? '读取中…' : '刷新名单列表'}
                  </button>
                  <div className={styles.spacer} />
                  <button
                    className={styles.smallBtn}
                    disabled={!listId || busy === 'preflightList'}
                    onClick={() => void runListPreflight()}
                  >
                    {busy === 'preflightList' ? '预检中…' : listPreflight ? '重新预检' : '预检'}
                  </button>
                </div>
                {listsError && <div className={styles.errBox}>名单读取失败：{listsError}</div>}
                {lists && lists.length === 0 && (
                  <div className={styles.muted}>远端账号下还没有名单；请先在 Klaviyo 创建名单，或到设置页确认默认名单。</div>
                )}
                {!listId && lists && lists.length > 0 && (
                  <div className={styles.muted}>请选择一个目标名单；到设置页配置默认名单后会自动选中它。</div>
                )}
                {listPreflight && (
                  <>
                    <div className={styles.sectionTitle}>
                      名单同步预检结果{listFresh ? '' : '（受众或目标名单已变化，需重新预检）'}
                    </div>
                    <PreflightMessages result={listPreflight} />
                    <div className={styles.kvGrid}>
                      <span className={styles.kvK}>账号</span>
                      <span className={styles.kvV}>
                        {summaryAccount(listPreflight.summary, status?.account?.label ?? '', status?.account?.id ?? null)}
                      </span>
                      <span className={styles.kvK}>店铺</span>
                      <span className={styles.kvV}>
                        {summaryStr(listPreflight.summary.storeKey) || status?.storeKey || '未知'}
                      </span>
                      <span className={styles.kvK}>目标名单</span>
                      <span className={styles.kvV}>
                        {summaryStr(listPreflight.summary.listName) || '未命名名单'}（
                        <code className={styles.mono}>{summaryStr(listPreflight.summary.listId) || listId}</code>）
                      </span>
                      <span className={styles.kvK}>范围</span>
                      <span className={styles.kvV}>
                        {summaryStr(listPreflight.summary.scopeLabel) || '当前筛选结果'} · 总{' '}
                        {countText(listPreflight.summary.total)}
                      </span>
                      <span className={styles.kvK}>将提交人数</span>
                      <span className={styles.kvV}>{countText(listPreflight.summary.willSubmit)}</span>
                      <span className={styles.kvK}>按规则排除人数</span>
                      <span className={styles.kvV}>{countText(listPreflight.summary.excludedByRule)}</span>
                    </div>
                    <div className={styles.rowActions}>
                      <button
                        className={styles.primaryBtn}
                        disabled={!listReady || busy === 'syncList'}
                        onClick={() => void runListSync()}
                      >
                        {busy === 'syncList' ? '同步中…' : '确认加入名单'}
                      </button>
                      {!listReady && (
                        <span className={styles.muted}>预检未通过或条件已变化时不能提交，请先重新预检。</span>
                      )}
                    </div>
                    <div className={styles.muted}>
                      只增加成员，不做全量覆盖；订阅 / 抑制状态不变。加入名单不代表用户同意营销，也不代表邮件已发送。
                    </div>
                  </>
                )}
              </div>
            </>
          )}

          {lastResult && <OperationResult op={lastResult} />}

          <div className={styles.section}>
            <div className={styles.sectionTitle}>执行记录</div>
            <div className={styles.muted}>
              同步与推送都会留下本地执行记录；「待继续」或「结果不明」的记录不会自动重试，需要先核对远端再显式继续。
            </div>
            <div className={styles.rowActions}>
              <button
                className={styles.smallBtn}
                disabled={busy === 'operations'}
                onClick={() => {
                  setBusy('operations');
                  void loadOperations().finally(() => setBusy((b) => (b === 'operations' ? null : b)));
                }}
              >
                {busy === 'operations' ? '读取中…' : '刷新执行记录'}
              </button>
              {operations && <span className={styles.muted}>最近 {operations.length} 条</span>}
            </div>
            {operationsError && <div className={styles.errBox}>{operationsError}</div>}
            {operations && operations.length === 0 && <div className={styles.muted}>还没有执行记录。</div>}
            {(operations ?? []).map((op) => (
              <div key={op.id} className={styles.versionItem}>
                <div className={styles.versionHead}>
                  <b>{KIND_LABELS[op.kind] ?? op.kind}</b>
                  <span className={statusClass(op.status)}>{STATUS_LABELS[op.status] ?? op.status}</span>
                  <span className={styles.versionMeta}>{formatDateTime(op.updatedAt)}</span>
                  <div className={styles.spacer} />
                  {(op.status === 'awaiting_resume' || op.status === 'unknown') && (
                    <button
                      className={styles.smallBtn}
                      disabled={busy === `resume:${op.id}`}
                      onClick={() => void resumeOperation(op)}
                    >
                      {busy === `resume:${op.id}` ? '继续中…' : '继续'}
                    </button>
                  )}
                </div>
                <div className={styles.versionNote}>{op.summary || '（无摘要）'}</div>
                <div className={styles.versionMeta}>
                  <code className={styles.mono}>{op.id}</code>
                  {op.resumable ? ' · 记录为可继续' : ''}
                  {op.steps.length ? ` · ${op.steps.length} 个步骤` : ''}
                </div>
              </div>
            ))}
          </div>

          {notice && <div className={notice.ok ? styles.noticeOk : styles.noticeErr}>{notice.text}</div>}
        </div>

        <div className={styles.modalFoot}>
          <span className={styles.modalHint}>
            本面板不创建 Campaign、不发送邮件、不修改订阅状态；私钥只存在服务端，页面只显示脱敏结果。
          </span>
        </div>
      </div>
    </div>
  );
}