'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { formatDateTime } from '@/components/customer-marketing/MarketingStatusTag';
import { errorText, readApiError } from '@/components/customer-marketing/useMarketingStatus';
import {
  FILTER_LABELS,
  SEGMENTS,
  TAG_NONE,
  cohortOf,
  describeFilters,
  type FilterKey,
  type Filters,
} from '@/lib/customer-segmentation';
import type { AudienceSnapshot, Preparation } from '@/lib/edm/types';
import { int } from '@/lib/format';
import type { CustomerRow } from '@/lib/mock';
import styles from './designer.module.css';

// 设计器里的受众选择器：与用户分析页共用同一套筛选语义
// （@/lib/customer-segmentation），命中人数由服务端重新计算并冻结为有时效的受众快照。
// 受众只通过不透明 audienceId 与模板关联，邮箱与完整客户资料不进入 URL。

export type AudienceSelection = {
  audienceId: string;
  mode: 'ids' | 'filters';
  label: string;
  total: number;
  mailable: number;
  pending: number;
};

/** 与 POST /api/edm/audiences 的 frozen contract 一致的请求体 */
type AudienceRequest = { mode: 'filters'; filters: Filters; tag: string | null; query: string };

/** POST /api/edm/audiences/preview 的响应（服务端 publicPreview） */
type AudiencePreview = {
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
  excluded: { reason: string; count: number }[];
  mock: boolean;
  candidateHash: string;
  expiresAt: string;
};

type TagMap = Record<string, string[]>;
type AudienceValidity = { valid: boolean; invalidReason: string | null };

const MODE = 'filters' as const;

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

function distinct(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))].sort((a, b) => a.localeCompare(b));
}

function Metric({ label, value }: { label: string; value: number }): React.ReactElement {
  return (
    <div className={styles.metricCell}>
      <div className={styles.metricLabel}>{label}</div>
      <div className={styles.metricValue}>{int(value)}</div>
    </div>
  );
}

export function AudiencePanel(props: {
  open: boolean;
  onClose: () => void;
  templateId: string;
  versionId: string;
  subject: string;
  previewText: string;
  selection: AudienceSelection | null;
  onSelect: (s: AudienceSelection | null) => void;
}): React.ReactElement {
  const [rows, setRows] = useState<CustomerRow[] | null>(null);
  const [tagMap, setTagMap] = useState<TagMap>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({});
  const [tag, setTag] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState<AudiencePreview | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<AudienceSnapshot | null>(null);
  const [snapshotKey, setSnapshotKey] = useState<string | null>(null);
  const [boundCheck, setBoundCheck] = useState<AudienceValidity | null>(null);
  const [boundError, setBoundError] = useState<string | null>(null);

  const audienceId = props.selection?.audienceId ?? null;

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [customersRes, tagsRes] = await Promise.all([fetch('/api/customers'), fetch('/api/tags')]);
      if (!customersRes.ok) throw new Error(await readApiError(customersRes));
      const data = (await customersRes.json()) as CustomerRow[];
      // 标签读取失败不阻塞筛选项：标签下拉留空即可，客户数据仍然可用
      let nextTags: TagMap = {};
      if (tagsRes.ok) {
        try {
          const parsed = (await tagsRes.json()) as TagMap;
          if (parsed && typeof parsed === 'object') nextTags = parsed;
        } catch {
          nextTags = {};
        }
      }
      setRows(Array.isArray(data) ? data : []);
      setTagMap(nextTags);
      setLoadError(null);
    } catch (e) {
      setRows(null);
      setLoadError(errorText(e, '客户列表读取失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 每次打开都重新读取，避免用上一次会话的客户范围算人数
    if (!props.open) return;
    void load();
  }, [props.open, load]);

  // 已绑定的快照是否仍然有效（数据源 / 店铺变化或过期后写入会被服务端拒绝）
  useEffect(() => {
    if (!props.open || !audienceId) {
      setBoundCheck(null);
      setBoundError(null);
      return;
    }
    let alive = true;
    fetch(`/api/edm/audiences/${encodeURIComponent(audienceId)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(await readApiError(r));
        return (await r.json()) as AudienceValidity;
      })
      .then((d) => {
        if (!alive) return;
        setBoundCheck({ valid: Boolean(d.valid), invalidReason: d.invalidReason ?? null });
        setBoundError(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setBoundCheck(null);
        setBoundError(errorText(e, '受众快照状态读取失败'));
      });
    return () => {
      alive = false;
    };
  }, [props.open, audienceId]);

  const segmentOptions = useMemo(() => SEGMENTS.map((s) => s.key), []);
  const sourceOptions = useMemo(() => distinct((rows ?? []).map((r) => r.source)), [rows]);
  const countryOptions = useMemo(() => distinct((rows ?? []).map((r) => r.country)), [rows]);
  const cohortOptions = useMemo(() => distinct((rows ?? []).map((r) => cohortOf(r))), [rows]);
  const tagOptions = useMemo(() => {
    const counts = new Map<string, number>();
    Object.values(tagMap).forEach((list) => list.forEach((t) => counts.set(t, (counts.get(t) ?? 0) + 1)));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }, [tagMap]);

  const request = useMemo<AudienceRequest>(() => ({ mode: MODE, filters, tag, query }), [filters, tag, query]);
  const requestKey = useMemo(() => JSON.stringify(request), [request]);
  const previewFresh = preview !== null && previewKey === requestKey;
  const snapshotFresh = snapshot !== null && snapshotKey === requestKey;
  const filterSummary = useMemo(() => describeFilters(filters, tag), [filters, tag]);
  const noCondition = filterSummary.length === 0 && !query.trim();

  // 范围一变，之前的预览 / 快照都不再对应当前条件，必须重新预览后才能保存
  useEffect(() => {
    setPreview(null);
    setPreviewKey(null);
    setSnapshot(null);
    setSnapshotKey(null);
  }, [requestKey]);

  const setFilter = useCallback((key: FilterKey, value: string): void => {
    setFilters((prev) => {
      const next: Filters = { ...prev };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
  }, []);

  const runPreview = async (): Promise<void> => {
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

  const saveAudience = async (): Promise<void> => {
    if (!preview || !previewFresh) {
      setNotice({ ok: false, text: '请先预览当前范围，确认人数与排除原因后再保存快照' });
      return;
    }
    setBusy('save');
    setNotice(null);
    try {
      // 快照必须与预览使用同一个请求体，否则保存下来的范围会和刚看到的不一致。
      // 请求只发往同源服务端，自由搜索里的邮箱只参与服务端计算。
      const res = await fetch('/api/edm/audiences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      const data = (await res.json()) as { audience: AudienceSnapshot };
      // 预览与保存之间数据源可能已经变化：人数对不上就不把这份快照交出去
      if (data.audience.counts.total !== preview.total || data.audience.counts.mailable !== preview.mailable) {
        setPreview(null);
        setPreviewKey(null);
        setSnapshot(null);
        setSnapshotKey(null);
        setNotice({
          ok: false,
          text: `保存前后的范围不一致（预览 ${int(preview.total)} 人 → 快照 ${int(data.audience.counts.total)} 人），数据源可能已变化，请重新预览确认`,
        });
        return;
      }
      setSnapshot(data.audience);
      setSnapshotKey(requestKey);
      setNotice({ ok: true, text: `受众快照已保存：${data.audience.id}，有效期至 ${formatDateTime(data.audience.expiresAt)}` });
    } catch (e) {
      setNotice({ ok: false, text: errorText(e, '受众快照保存失败') });
    } finally {
      setBusy(null);
    }
  };

  /** 保存「模板版本 + 受众」的本地邮件准备记录，并把受众绑定回设计器 */
  const confirmUse = async (): Promise<void> => {
    if (!snapshot || !snapshotFresh || !preview) {
      setNotice({ ok: false, text: '请先保存当前范围的受众快照，再确认使用' });
      return;
    }
    setBusy('prepare');
    setNotice(null);
    try {
      const res = await fetch('/api/edm/preparations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId: props.templateId,
          versionId: props.versionId,
          audienceId: snapshot.id,
          subject: props.subject,
          previewText: props.previewText,
        }),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      const data = (await res.json()) as { preparation: Preparation };
      props.onSelect({
        audienceId: snapshot.id,
        mode: preview.mode,
        label: preview.scopeLabel,
        total: snapshot.counts.total,
        mailable: snapshot.counts.mailable,
        pending: snapshot.counts.pending,
      });
      setNotice({
        ok: true,
        text: `已绑定该受众，并记录邮件准备 ${data.preparation.id}；准备记录只关联模板版本与受众，不是 Campaign，也不代表已发送`,
      });
    } catch (e) {
      setNotice({ ok: false, text: errorText(e, '邮件准备记录保存失败') });
    } finally {
      setBusy(null);
    }
  };

  const clearSelection = (): void => {
    props.onSelect(null);
    setSnapshot(null);
    setSnapshotKey(null);
    setNotice({ ok: true, text: '已清除受众选择；推送面板里的受众写入会同时停用' });
  };

  if (!props.open) return <></>;

  return (
    <div className={styles.modalMask} onClick={props.onClose}>
      <div className={`${styles.modal} ${styles.modalWide}`} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <b>选择受众</b>
          <span className={styles.muted}>与用户分析页共用同一套筛选规则；人数由服务端重新计算，并冻结为有时效的受众快照</span>
          <div className={styles.spacer} />
          <button className={styles.smallBtn} onClick={props.onClose}>
            关闭
          </button>
        </div>

        <div className={styles.modalBody}>
          <div className={styles.section}>
            <div className={styles.sectionTitle}>当前绑定的受众</div>
            {props.selection ? (
              <>
                <div className={styles.kvGrid}>
                  <span className={styles.kvK}>受众快照</span>
                  <span className={styles.kvV}>
                    <code className={styles.mono}>{props.selection.audienceId}</code>
                  </span>
                  <span className={styles.kvK}>范围</span>
                  <span className={styles.kvV}>
                    {props.selection.label}（{props.selection.mode === 'ids' ? '勾选用户' : '当前筛选结果'}）
                  </span>
                  <span className={styles.kvK}>人数</span>
                  <span className={styles.kvV}>
                    总 {int(props.selection.total)} 人 · 可用于营销 {int(props.selection.mailable)} 人 · 待确认{' '}
                    {int(props.selection.pending)} 人
                  </span>
                </div>
                {boundError && (
                  <div className={styles.warnBox}>
                    快照状态读取失败：{boundError}；写入前请在服务端重新确认它是否仍然有效。
                  </div>
                )}
                {boundCheck?.valid === false && (
                  <div className={styles.warnBox}>
                    该快照已失效：{boundCheck.invalidReason ?? '原因未知'}。请重新预览并保存新的快照。
                  </div>
                )}
                {boundCheck?.valid === true && (
                  <div className={styles.muted}>服务端确认该快照仍然有效（数据源与店铺未变化，且在有效期内）。</div>
                )}
                <div className={styles.rowActions}>
                  <button className={styles.dangerBtn} onClick={clearSelection}>
                    清除选择
                  </button>
                </div>
              </>
            ) : (
              <div className={styles.muted}>
                当前没有绑定受众。同一模板可用于多个受众，同一受众也可以换用其他模板；受众只通过服务端生成的不透明
                audienceId 关联。
              </div>
            )}
            <div className={styles.rowActions}>
              <Link className={styles.backLink} href="/customers" target="_blank" rel="noreferrer">
                到用户分析页选择受众 ↗
              </Link>
              <span className={styles.muted}>在新标签页打开，避免丢掉设计器里未保存的修改。</span>
            </div>
          </div>

          <div className={styles.section}>
            <div className={styles.sectionTitle}>筛选条件（与用户分析页同一套规则）</div>
            {loading && <div className={styles.muted}>客户与标签加载中…</div>}
            {loadError && (
              <div className={styles.errBox}>
                {loadError}
                <div className={styles.rowActions}>
                  <button className={styles.smallBtn} onClick={() => void load()}>
                    重试
                  </button>
                </div>
              </div>
            )}
            <div className={styles.filterGrid}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{FILTER_LABELS.segment}</span>
                <select
                  className={styles.select}
                  value={filters.segment ?? ''}
                  onChange={(e) => setFilter('segment', e.target.value)}
                >
                  <option value="">全部分层</option>
                  {segmentOptions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{FILTER_LABELS.source}</span>
                <select className={styles.select} value={filters.source ?? ''} onChange={(e) => setFilter('source', e.target.value)}>
                  <option value="">全部渠道</option>
                  {sourceOptions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{FILTER_LABELS.country}</span>
                <select className={styles.select} value={filters.country ?? ''} onChange={(e) => setFilter('country', e.target.value)}>
                  <option value="">全部国家</option>
                  {countryOptions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{FILTER_LABELS.cohort}</span>
                <select className={styles.select} value={filters.cohort ?? ''} onChange={(e) => setFilter('cohort', e.target.value)}>
                  <option value="">全部首购月</option>
                  {cohortOptions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>标签</span>
                <select className={styles.select} value={tag ?? ''} onChange={(e) => setTag(e.target.value || null)}>
                  <option value="">全部标签</option>
                  <option value={TAG_NONE}>未打标签</option>
                  {tagOptions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>自由搜索</span>
                <input
                  className={styles.textInput}
                  value={query}
                  placeholder="邮箱 / 国家 / 渠道 / 分层 / 标签…"
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
            </div>
            <div className={styles.rowActions}>
              <label className={styles.rowActions}>
                <input
                  type="checkbox"
                  checked={filters.abandon === '1'}
                  onChange={(e) => setFilter('abandon', e.target.checked ? '1' : '')}
                />
                {FILTER_LABELS.abandon}客户（弃购次数 &gt; 0）
              </label>
            </div>
            <div className={styles.muted}>
              自由搜索可能包含邮箱：关键字只随请求发往同源服务端参与计算，不会写入 URL、日志或本地存储。
            </div>
            {noCondition && (
              <div className={styles.warnBox}>当前没有任何筛选条件：范围等于全部客户，请确认这是你要的范围。</div>
            )}
            <div className={styles.rowActions}>
              <button className={styles.primaryBtn} disabled={busy === 'preview'} onClick={() => void runPreview()}>
                {busy === 'preview' ? '预览中…' : '预览人数与排除原因'}
              </button>
              <button
                className={styles.smallBtn}
                disabled={!previewFresh || busy === 'save'}
                onClick={() => void saveAudience()}
              >
                {busy === 'save' ? '保存中…' : '保存为受众快照'}
              </button>
              <button className={styles.linkBtn} disabled={loading} onClick={() => void load()}>
                重新载入筛选项
              </button>
            </div>
            {previewFresh ? (
              <div className={styles.muted}>预览范围与当前筛选一致，可以保存快照。</div>
            ) : (
              <div className={styles.muted}>保存前必须先用当前筛选条件预览一次，避免保存过期的范围。</div>
            )}
          </div>

          {preview && (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>预览结果{previewFresh ? '' : '（范围已变化，需重新预览）'}</div>
              <div className={styles.metricGrid}>
                <Metric label="总人数" value={preview.total} />
                <Metric label="邮箱有效" value={preview.validEmail} />
                <Metric label="重复邮箱" value={preview.duplicateEmail} />
                <Metric label="可用于营销" value={preview.mailable} />
                <Metric label="待确认" value={preview.pending} />
              </div>
              {preview.mock && (
                <div className={styles.warnBox}>
                  这是演示数据（Mock）：只能用于流程模拟，不能写入 Klaviyo；服务端也会拒绝真实客户写入。这份受众不能用于资料同步或名单同步。
                </div>
              )}
              <div className={styles.kvGrid}>
                <span className={styles.kvK}>作用范围</span>
                <span className={styles.kvV}>{preview.scopeLabel}</span>
                <span className={styles.kvK}>数据源</span>
                <span className={styles.kvV}>
                  {preview.mock ? '演示数据 (Mock)' : `真实数据源 ${preview.storeKey}`} · 指纹{' '}
                  <code className={styles.mono}>{preview.sourceRevision.slice(0, 8)}</code>
                  {preview.syncedAt ? ` · 同步于 ${formatDateTime(preview.syncedAt)}` : ''}
                </span>
                <span className={styles.kvK}>范围指纹</span>
                <span className={styles.kvV}>
                  <code className={styles.mono}>{preview.candidateHash.slice(0, 8)}</code>
                  （与上次不同说明命中人群已变化）
                </span>
                <span className={styles.kvK}>筛选条件</span>
                <span className={styles.kvV}>
                  {preview.filters.length ? preview.filters.join(' · ') : '无筛选条件'}
                  {query.trim() ? ' · 自由搜索已应用' : ''}
                </span>
                <span className={styles.kvK}>到期时间</span>
                <span className={styles.kvV}>{formatDateTime(preview.expiresAt)}（到期或数据源变化后需重新预览）</span>
              </div>
              <div className={styles.sectionTitle}>排除原因明细</div>
              {preview.excluded.length === 0 ? (
                <div className={styles.muted}>没有排除项。</div>
              ) : (
                <div className={styles.kvGrid}>
                  {preview.excluded.map((x) => (
                    <Fragment key={x.reason}>
                      <span className={styles.kvK}>
                        <code className={styles.mono}>{x.reason}</code>
                      </span>
                      <span className={styles.kvV}>
                        {EXCLUSION_TEXT[x.reason] ?? '未知原因，请对照服务端日志'} · {int(x.count)} 人
                      </span>
                    </Fragment>
                  ))}
                </div>
              )}
            </div>
          )}

          {snapshot && (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>已保存的受众快照（尚未绑定到设计器）</div>
              <div className={styles.kvGrid}>
                <span className={styles.kvK}>快照 ID</span>
                <span className={styles.kvV}>
                  <code className={styles.mono}>{snapshot.id}</code>
                </span>
                <span className={styles.kvK}>人数</span>
                <span className={styles.kvV}>
                  总 {int(snapshot.counts.total)} · 邮箱有效 {int(snapshot.counts.validEmail)} · 重复邮箱{' '}
                  {int(snapshot.counts.duplicateEmail)} · 可用于营销 {int(snapshot.counts.mailable)} · 待确认{' '}
                  {int(snapshot.counts.pending)}
                </span>
                <span className={styles.kvK}>到期</span>
                <span className={styles.kvV}>{formatDateTime(snapshot.expiresAt)}</span>
              </div>
              {!snapshotFresh && (
                <div className={styles.warnBox}>筛选条件已变化：这个快照不再对应当前范围，请重新预览并保存。</div>
              )}
              <div className={styles.rowActions}>
                <button
                  className={styles.primaryBtn}
                  disabled={!snapshotFresh || busy === 'prepare'}
                  onClick={() => void confirmUse()}
                >
                  {busy === 'prepare' ? '记录中…' : '确认使用该受众'}
                </button>
                <span className={styles.muted}>
                  会写入「模板版本 + 受众 + 主题/预览文字」的本地邮件准备记录；它不是 Campaign，也不会发送邮件。
                </span>
              </div>
            </div>
          )}

          {notice && <div className={notice.ok ? styles.noticeOk : styles.noticeErr}>{notice.text}</div>}
        </div>

        <div className={styles.modalFoot}>
          <span className={styles.modalHint}>
            受众通过服务端生成的不透明 audienceId 关联；邮箱、完整客户资料和长串客户 ID 不会出现在 URL 里。
          </span>
        </div>
      </div>
    </div>
  );
}