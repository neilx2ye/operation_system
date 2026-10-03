'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LOCAL_ASSET_PREFIX, lintEmailHtml } from '@/lib/edm/html';
import {
  analyzeHtml,
  escapeHtml,
  getAttribute,
  replaceRange,
  type SourceRange,
} from '@/lib/edm/html-edit';
import type { Asset, LintIssue, LintResult, Template, TemplateVersion, TemplateVersionMeta } from '@/lib/edm/types';
import { AssetPicker } from './AssetPicker';
import { AudiencePanel, type AudienceSelection } from './AudiencePanel';
import { ElementInspector, applyAttributePatches } from './ElementInspector';
import { HtmlCodeEditor } from './HtmlCodeEditor';
import { KlaviyoPanel } from './KlaviyoPanel';
import { PreviewFrame } from './PreviewFrame';
import { VersionPanel } from './VersionPanel';
import styles from './designer.module.css';

type DesignerData = {
  template: Template;
  version: TemplateVersion;
  versions: TemplateVersionMeta[];
};

type PanelTab = 'element' | 'code' | 'versions';
type PreviewMode = 'desktop' | 'mobile';
type Notice = { ok: boolean; text: string };
type MetaDraft = { name: string; subject: string; previewText: string };
type AssetRequest = 'src' | 'insert';

const ZOOMS = [50, 75, 100, 125];
const TABS: { key: PanelTab; label: string }[] = [
  { key: 'element', label: '元素' },
  { key: 'code', label: '源码' },
  { key: 'versions', label: '版本' },
];
/** 预览里插入 <img> 会破坏内容的元素 */
const INSERT_BLOCKED = new Set(['script', 'style', 'title', 'textarea', 'head', 'html']);

// lib/edm/html.ts 的检查逻辑用 Buffer.byteLength 统计体积；浏览器端没有这个全局对象，
// 这里用 TextEncoder 补一个等价实现，保证客户端检查结果与服务端一致。
(globalThis as { Buffer?: { byteLength?: (input: string) => number } }).Buffer ??= {
  byteLength: (input: string) => new TextEncoder().encode(input).length,
};

/**
 * EDM 邮件模板设计器。
 *
 * 数据流：source（草稿 ?? 选定版本 HTML）→ 防抖 250ms → previewSource →
 * analyzeHtml(..., { preview: true }) → 注入 data-edm-el 的预览 HTML → iframe。
 * 预览里点击元素得到 records 下标；所有编辑都通过 html-edit 的
 * setAttributes / setTextSegment 写回草稿字符串。
 */
export function TemplateDesigner({ templateId }: { templateId: string }): React.ReactElement {
  const [data, setData] = useState<DesignerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [viewed, setViewed] = useState<TemplateVersion | null>(null);
  const [previewSource, setPreviewSource] = useState('');
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [tab, setTab] = useState<PanelTab>('element');
  const [mode, setMode] = useState<PreviewMode>('desktop');
  const [zoom, setZoom] = useState(100);
  const [meta, setMeta] = useState<MetaDraft | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetsError, setAssetsError] = useState<string | null>(null);
  const [assetRequest, setAssetRequest] = useState<AssetRequest | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [serverLint, setServerLint] = useState<LintResult | null>(null);
  const [serverLintBusy, setServerLintBusy] = useState(false);
  const [audience, setAudience] = useState<AudienceSelection | null>(null);
  const [audienceOpen, setAudienceOpen] = useState(false);
  const [klaviyoOpen, setKlaviyoOpen] = useState(false);

  const reload = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    try {
      const res = await fetch(`/api/edm/templates/${templateId}`);
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) throw new Error(readMessage(body, `模板加载失败（${res.status}）`));
      const next = body as DesignerData;
      setData(next);
      setDraft(null);
      setViewed(null);
      setSelectedIndex(null);
      setPreviewSource(next.version.html);
      setMeta({ name: next.template.name, subject: next.template.subject, previewText: next.template.previewText });
      setConflict(false);
      setServerLint(null);
      setLoadError(null);
      return true;
    } catch (err) {
      setLoadError(errorMessage(err, '模板加载失败'));
      return false;
    } finally {
      setLoading(false);
    }
  }, [templateId]);

  const reloadAssets = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/edm/assets');
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) throw new Error(readMessage(body, `素材库加载失败（${res.status}）`));
      setAssets((body as { assets: Asset[] }).assets);
      setAssetsError(null);
    } catch (err) {
      setAssetsError(errorMessage(err, '素材库加载失败'));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    void reloadAssets();
  }, [reloadAssets]);

  const currentVersionId = data?.template.currentVersionId ?? '';
  const shown: TemplateVersion | null = data ? (viewed ?? data.version) : null;
  const isHead = shown !== null && shown.id === currentVersionId;
  const readOnly = shown !== null && !isHead;
  const source = shown === null ? '' : isHead ? (draft ?? shown.html) : shown.html;
  const dirty = draft !== null;

  // 打字 250ms 后才刷新预览：既避免每个按键重建文档，也让 iframe 保持同一个文档对象
  useEffect(() => {
    if (source === previewSource) return;
    const timer = window.setTimeout(() => setPreviewSource(source), 250);
    return () => window.clearTimeout(timer);
  }, [source, previewSource]);

  const previewAnalysis = useMemo(() => analyzeHtml(previewSource, { preview: true }), [previewSource]);
  const records = useMemo(() => analyzeHtml(source, { preview: false }).records, [source]);
  const selected = selectedIndex === null ? null : (records[selectedIndex] ?? null);
  const selectionRange = useMemo<SourceRange | null>(
    () => (selected ? { start: selected.start, end: selected.end } : null),
    [selected],
  );
  // 只在「换了选中元素 / 换了版本」时重新高亮，打字过程中不挪动编辑器光标
  const selectionToken = selected && shown ? `${shown.id}:${selectedIndex}` : null;
  const childCount = useMemo(
    () => (selected ? records.filter((record) => record.parentIndex === selected.index).length : 0),
    [records, selected],
  );

  const localAssetInfo = useMemo(() => {
    if (!selected || selected.tag !== 'img') return { id: null as string | null, asset: null as Asset | null };
    const src = getAttribute(source, selected, 'src') ?? '';
    if (!src.startsWith(LOCAL_ASSET_PREFIX)) return { id: null as string | null, asset: null as Asset | null };
    const id = src.slice(LOCAL_ASSET_PREFIX.length).split(/[?#]/)[0];
    return { id, asset: assets.find((item) => item.id === id) ?? null };
  }, [selected, source, assets]);

  const knownAssetIds = useMemo(() => assets.map((item) => item.id), [assets]);
  const clientLint = useMemo(() => lintEmailHtml(source, { knownAssetIds }), [source, knownAssetIds]);
  const clientIssues = useMemo(() => sortIssues(clientLint.issues), [clientLint]);
  const errorCount = clientIssues.filter((issue) => issue.level === 'error').length;
  const warnCount = clientIssues.length - errorCount;

  useEffect(() => {
    if (selectedIndex !== null && selectedIndex >= records.length) setSelectedIndex(null);
  }, [selectedIndex, records]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  if (loading && !data) {
    return (
      <div className={styles.page}>
        <div className={styles.emptyBox}>模板加载中…</div>
      </div>
    );
  }

  if (!data || !shown) {
    return (
      <div className={styles.page}>
        <div className={styles.errBox}>{loadError ?? '模板不存在或已被删除。'}</div>
        <div className={styles.rowActions}>
          <button className={styles.smallBtn} onClick={() => void reload()}>
            重试
          </button>
          <Link className={styles.backLink} href="/edm">
            返回模板库
          </Link>
        </div>
      </div>
    );
  }

  const metaDirty =
    meta !== null &&
    (meta.name.trim() !== data.template.name ||
      meta.subject !== data.template.subject ||
      meta.previewText !== data.template.previewText);
  const exportName = `${safeFileName(data.template.name)}-${safeFileName(shown.id)}.html`;
  const stripped = previewAnalysis.stripped;

  function setMetaField(field: keyof MetaDraft, value: string): void {
    setMeta((prev) => (prev ? { ...prev, [field]: value } : prev));
  }

  // 走到这里 data 一定存在；下面的函数体内也显式用别名，避免闭包里收窄丢失
  const headTemplate = data.template;
  const headVersion = data.version;
  const allVersions = data.versions;

  /** 切换预览/编辑的版本；传入 null 表示回到最新版本 */
  function viewVersion(next: TemplateVersion | null): void {
    const target = next && next.id === headVersion.id ? null : next;
    setViewed(target);
    setSelectedIndex(null);
    setPreviewSource(target ? target.html : (draft ?? headVersion.html));
  }

  async function openVersion(versionId: string): Promise<void> {
    if (versionId === headVersion.id) {
      viewVersion(null);
      return;
    }
    setNotice(null);
    try {
      const res = await fetch(`/api/edm/templates/${templateId}/versions/${versionId}`);
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) throw new Error(readMessage(body, `版本读取失败（${res.status}）`));
      viewVersion((body as { version: TemplateVersion }).version);
    } catch (err) {
      setNotice({ ok: false, text: errorMessage(err, '版本读取失败') });
    }
  }

  function refreshWithConfirm(): void {
    if (dirty && !window.confirm('刷新会丢弃当前未保存的修改，确定继续？')) return;
    void reload();
  }

  async function saveVersion(note: string): Promise<boolean> {
    if (readOnly) {
      setNotice({ ok: false, text: '正在查看历史版本，请先切回最新版本再保存' });
      return false;
    }
    if (draft === null) {
      setNotice({ ok: false, text: '当前没有需要保存的修改' });
      return false;
    }
    const html = draft;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/edm/templates/${templateId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html, note, expectedRevision: headTemplate.revision }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (res.status === 409) {
        setConflict(true);
        setNotice({ ok: false, text: '模板已被其他操作修改，请刷新后重试' });
        return false;
      }
      if (!res.ok) {
        setNotice({ ok: false, text: readMessage(body, `保存失败（${res.status}）`) });
        return false;
      }
      const created = body as { template: Template; version: TemplateVersionMeta };
      const version: TemplateVersion = { ...created.version, html };
      setData({
        template: created.template,
        version,
        versions: [created.version, ...allVersions.filter((item) => item.id !== created.version.id)],
      });
      setViewed(null);
      setDraft(null);
      setSelectedIndex(null);
      setPreviewSource(html);
      setConflict(false);
      setNotice({ ok: true, text: '已保存为新版本' });
      return true;
    } catch (err) {
      setNotice({ ok: false, text: errorMessage(err, '保存失败') });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function rollbackTo(versionId: string): Promise<void> {
    const confirmed = window.confirm(
      '回滚会以所选版本的内容创建一个新版本：当前版本不会被删除，历史版本也不会被覆盖。确定继续？',
    );
    if (!confirmed) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/edm/templates/${templateId}/versions/${versionId}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: headTemplate.revision }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (res.status === 409) {
        setConflict(true);
        setNotice({ ok: false, text: '模板已被其他操作修改，请刷新后重试' });
        return;
      }
      if (!res.ok) {
        setNotice({ ok: false, text: readMessage(body, `回滚失败（${res.status}）`) });
        return;
      }
      setNotice({ ok: true, text: '已按所选版本生成回滚版本' });
      await reload();
    } catch (err) {
      setNotice({ ok: false, text: errorMessage(err, '回滚失败') });
    } finally {
      setBusy(false);
    }
  }

  async function saveMeta(): Promise<void> {
    if (!meta) return;
    const name = meta.name.trim();
    if (!name) {
      setNotice({ ok: false, text: '模板名称不能为空' });
      return;
    }
    if (!metaDirty) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/edm/templates/${templateId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          subject: meta.subject,
          previewText: meta.previewText,
          revision: headTemplate.revision,
        }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (res.status === 409) {
        setConflict(true);
        setNotice({ ok: false, text: '模板已被其他操作修改，请刷新后重试' });
        return;
      }
      if (!res.ok) {
        setNotice({ ok: false, text: readMessage(body, `保存失败（${res.status}）`) });
        return;
      }
      const saved = (body as { template: Template }).template;
      setData({ template: saved, version: headVersion, versions: allVersions });
      setMeta({ name: saved.name, subject: saved.subject, previewText: saved.previewText });
      setNotice({ ok: true, text: '模板信息已保存' });
    } catch (err) {
      setNotice({ ok: false, text: errorMessage(err, '保存失败') });
    } finally {
      setBusy(false);
    }
  }

  async function uploadAsset(file: File): Promise<Asset> {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/edm/assets', { method: 'POST', body: form });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new Error(readMessage(body, `素材上传失败（${res.status}）`));
    const asset = (body as { asset: Asset }).asset;
    setAssets((prev) => [asset, ...prev.filter((item) => item.id !== asset.id)]);
    return asset;
  }

  function handleUpload(file: File): void {
    const request = assetRequest;
    setPickerBusy(true);
    setPickerError(null);
    void uploadAsset(file)
      .then((asset) => {
        setNotice({ ok: true, text: `已上传素材 ${asset.filename}` });
        if (request === 'src') applyAssetSrc(asset);
        if (request === 'insert') applyAssetInsert(asset);
        setAssetRequest(null);
      })
      .catch((err: unknown) => setPickerError(errorMessage(err, '素材上传失败')))
      .finally(() => setPickerBusy(false));
  }

  async function removeAsset(asset: Asset): Promise<void> {
    if (!window.confirm(`删除素材「${asset.filename}」？被模板引用时会删除失败。`)) return;
    setPickerBusy(true);
    setPickerError(null);
    try {
      const res = await fetch(`/api/edm/assets/${asset.id}`, { method: 'DELETE' });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setPickerError(
          readMessage(body, res.status === 409 ? '该素材仍被模板引用，请先替换引用再删除' : `删除失败（${res.status}）`),
        );
        return;
      }
      setAssets((prev) => prev.filter((item) => item.id !== asset.id));
      setNotice({ ok: true, text: `已删除素材 ${asset.filename}` });
    } catch (err) {
      setPickerError(errorMessage(err, '素材删除失败'));
    } finally {
      setPickerBusy(false);
    }
  }

  function applyAssetSrc(asset: Asset): void {
    if (!selected || selected.tag !== 'img') {
      setNotice({ ok: false, text: '请先在预览里选中一个 <img> 元素' });
      return;
    }
    setDraft(applyAttributePatches(source, selected, [{ name: 'src', value: `${LOCAL_ASSET_PREFIX}${asset.id}` }]));
  }

  /** 在选中元素内部（闭合标签前）插入素材图片；未选中时插到 </body> 之前 */
  function applyAssetInsert(asset: Asset): void {
    const tag = `<img src="${LOCAL_ASSET_PREFIX}${asset.id}" alt="${escapeAttr(asset.filename)}" style="max-width:100%" />`;
    let at: number;
    if (selected) {
      if (INSERT_BLOCKED.has(selected.tag)) {
        setNotice({ ok: false, text: '该元素内不适合插入图片，请在预览里选择其他元素' });
        return;
      }
      at = selected.closeStart !== null ? selected.closeStart : selected.end;
    } else {
      const bodyClose = /<\/body\s*>/i.exec(source);
      at = bodyClose ? bodyClose.index : source.length;
    }
    setDraft(replaceRange(source, { start: at, end: at }, tag));
  }

  async function runServerLint(): Promise<void> {
    setServerLintBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/edm/templates/${templateId}/lint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: source }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setNotice({ ok: false, text: readMessage(body, `服务端检查失败（${res.status}）`) });
        return;
      }
      setServerLint(body as LintResult);
    } catch (err) {
      setNotice({ ok: false, text: errorMessage(err, '服务端检查失败') });
    } finally {
      setServerLintBusy(false);
    }
  }

  function guardBack(event: React.MouseEvent<HTMLAnchorElement>): void {
    if (!dirty) return;
    if (!window.confirm('有未保存的修改，离开后将会丢失。确定返回模板库？')) event.preventDefault();
  }

  function handlePreviewSelect(index: number | null): void {
    setSelectedIndex(index);
    if (index !== null) setTab('element');
  }

  function handlePickAsset(asset: Asset): void {
    if (assetRequest === 'src') applyAssetSrc(asset);
    else if (assetRequest === 'insert') applyAssetInsert(asset);
    setAssetRequest(null);
  }

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div className={styles.headTop}>
          <Link className={styles.backLink} href="/edm" onClick={guardBack}>
            ← 返回模板库
          </Link>
          <input
            className={styles.nameInput}
            value={meta?.name ?? data.template.name}
            placeholder="模板名称"
            onChange={(e) => setMetaField('name', e.target.value)}
          />
          {dirty && <span className={styles.dirtyBadge}>未保存</span>}
          <div className={styles.spacer} />
          <button className={styles.smallBtn} onClick={() => setAudienceOpen(true)}>
            受众
          </button>
          <button className={styles.smallBtn} onClick={() => setKlaviyoOpen(true)}>
            Klaviyo 推送
          </button>
          <button className={styles.smallBtn} disabled={!metaDirty || busy} onClick={() => void saveMeta()}>
            保存信息
          </button>
          <button
            className={styles.primaryBtn}
            disabled={!dirty || busy || readOnly}
            onClick={() => void saveVersion('')}
          >
            {busy ? '处理中…' : '保存为新版本'}
          </button>
        </div>

        <div className={styles.headMeta}>
          <label className={styles.metaField}>
            <span className={styles.fieldLabel}>邮件主题</span>
            <input
              className={styles.textInput}
              value={meta?.subject ?? ''}
              placeholder="收件箱里显示的邮件主题"
              onChange={(e) => setMetaField('subject', e.target.value)}
            />
          </label>
          <label className={styles.metaField}>
            <span className={styles.fieldLabel}>预览文字 preview text</span>
            <input
              className={styles.textInput}
              value={meta?.previewText ?? ''}
              placeholder="主题旁边的一行摘要"
              onChange={(e) => setMetaField('previewText', e.target.value)}
            />
          </label>
          <div className={styles.headHint}>
            主题与预览文字随「保存信息」写入模板；HTML 正文通过「保存为新版本」生成不可变版本。
          </div>
        </div>

        {notice && <div className={notice.ok ? styles.noticeOk : styles.noticeErr}>{notice.text}</div>}
        {conflict && (
          <div className={styles.noticeErr}>
            模板已被其他操作修改，请刷新后重试。
            <button className={styles.smallBtn} onClick={refreshWithConfirm}>
              刷新
            </button>
          </div>
        )}
        {readOnly && (
          <div className={styles.infoBox}>
            正在查看历史版本 {shown.id}（只读），预览与源码都是该版本内容。
            <button className={styles.smallBtn} onClick={() => viewVersion(null)}>
              切回最新版本
            </button>
          </div>
        )}
        {readOnly && dirty && (
          <div className={styles.warnBox}>最新版本上还有未保存的修改，切回最新版本后可以继续编辑或保存。</div>
        )}
      </div>

      <div className={styles.workspace}>
        <section className={styles.panelCard}>
          <div className={styles.previewBar}>
            <div className={styles.segGroup}>
              <button
                className={mode === 'desktop' ? styles.segOn : styles.seg}
                onClick={() => setMode('desktop')}
              >
                桌面
              </button>
              <button className={mode === 'mobile' ? styles.segOn : styles.seg} onClick={() => setMode('mobile')}>
                手机
              </button>
            </div>
            <div className={styles.segGroup}>
              {ZOOMS.map((value) => (
                <button
                  key={value}
                  className={zoom === value ? styles.segOn : styles.seg}
                  onClick={() => setZoom(value)}
                >
                  {value}%
                </button>
              ))}
            </div>
            <div className={styles.spacer} />
            <span className={styles.previewNote}>
              {stripped.scripts + stripped.eventAttrs > 0
                ? `预览已移除 ${stripped.scripts} 段脚本 / ${stripped.eventAttrs} 个事件属性`
                : '预览未移除脚本或事件属性'}
            </span>
          </div>
          <PreviewFrame
            frameKey={shown.id}
            html={previewAnalysis.previewHtml}
            mode={mode}
            zoom={zoom}
            selectedIndex={selectedIndex}
            onSelect={handlePreviewSelect}
          />
        </section>

        <aside className={styles.rightCol}>
          <div className={styles.tabBar}>
            {TABS.map((item) => (
              <button
                key={item.key}
                className={tab === item.key ? styles.tabOn : styles.tab}
                onClick={() => setTab(item.key)}
              >
                {item.label}
                {item.key === 'element' && selected !== null ? ' · 已选中' : ''}
                {item.key === 'code' && errorCount > 0 ? ` · ${errorCount} 错误` : ''}
              </button>
            ))}
          </div>

          <div className={styles.panelBody}>
            {tab === 'element' &&
              (selected ? (
                <div className={styles.tabScroll}>
                  <ElementInspector
                    source={source}
                    element={selected}
                    childCount={childCount}
                    readOnly={readOnly}
                    localAsset={localAssetInfo.asset}
                    localAssetId={localAssetInfo.id}
                    onSourceChange={setDraft}
                    onRequestAsset={(request) => {
                      setPickerError(null);
                      setAssetRequest(request);
                    }}
                    onClear={() => setSelectedIndex(null)}
                  />
                </div>
              ) : (
                <div className={styles.emptyBox}>
                  在左侧预览里点击任意元素开始编辑：文案、图片地址、链接，或插入素材。
                </div>
              ))}

            {tab === 'code' && (
              <div className={styles.codeTab}>
                <div className={styles.lintHeader}>
                  <b>源码检查</b>
                  <span className={styles.muted}>
                    {clientIssues.length === 0
                      ? '未发现问题'
                      : `${errorCount} 个错误 · ${warnCount} 个警告`}
                  </span>
                  <div className={styles.spacer} />
                  <button className={styles.smallBtn} disabled={serverLintBusy} onClick={() => void runServerLint()}>
                    {serverLintBusy ? '检查中…' : '服务端检查'}
                  </button>
                </div>
                <LintStrip issues={clientIssues} emptyText="本地检查未发现问题。" />
                {serverLint && (
                  <>
                    <div className={styles.lintHeader}>
                      <b>服务端检查结果</b>
                      <div className={styles.spacer} />
                      <button className={styles.linkBtn} onClick={() => setServerLint(null)}>
                        清除
                      </button>
                    </div>
                    <LintStrip issues={sortIssues(serverLint.issues)} emptyText="服务端检查未发现问题。" />
                  </>
                )}
                <HtmlCodeEditor
                  value={source}
                  onChange={(next) => {
                    if (!readOnly) setDraft(next);
                  }}
                  readOnly={readOnly}
                  selectionRange={selectionRange}
                  selectionToken={selectionToken}
                  fileName={exportName}
                  onUploadImage={uploadAsset}
                />
              </div>
            )}

            {tab === 'versions' && (
              <div className={styles.tabScroll}>
                <VersionPanel
                  templateId={templateId}
                  versions={data.versions}
                  currentVersionId={currentVersionId}
                  viewingVersionId={shown.id}
                  currentHtml={data.version.html}
                  dirty={dirty && !readOnly}
                  busy={busy}
                  onSelectVersion={(versionId) => void openVersion(versionId)}
                  onSave={saveVersion}
                  onRollback={(versionId) => void rollbackTo(versionId)}
                />
              </div>
            )}
          </div>
        </aside>
      </div>

      <AssetPicker
        open={assetRequest !== null}
        title={assetRequest === 'insert' ? '插入素材' : '从素材库选择图片'}
        hint={
          assetRequest === 'insert'
            ? selected
              ? '点击素材即可插入到当前选中元素内部。'
              : '未选中元素，素材会插入到 </body> 之前。'
            : '点击素材即可替换当前 <img> 的 src。'
        }
        assets={assets}
        busy={pickerBusy}
        error={pickerError ?? assetsError}
        onClose={() => {
          setAssetRequest(null);
          setPickerError(null);
        }}
        onPick={handlePickAsset}
        onUpload={handleUpload}
        onDelete={(asset) => void removeAsset(asset)}
      />

      <AudiencePanel
        open={audienceOpen}
        onClose={() => setAudienceOpen(false)}
        templateId={templateId}
        versionId={shown.id}
        subject={meta?.subject ?? data.template.subject}
        previewText={meta?.previewText ?? data.template.previewText}
        selection={audience}
        onSelect={setAudience}
      />

      <KlaviyoPanel
        open={klaviyoOpen}
        onClose={() => setKlaviyoOpen(false)}
        templateId={templateId}
        versionId={shown.id}
        dirty={dirty}
        audienceId={audience?.audienceId ?? null}
      />
    </div>
  );
}

function LintStrip(props: { issues: LintIssue[]; emptyText: string }): React.ReactElement {
  if (props.issues.length === 0) return <div className={styles.lintEmpty}>{props.emptyText}</div>;
  return (
    <div className={styles.lintStrip}>
      {props.issues.map((issue, index) => (
        <div
          key={`${issue.rule}-${index}`}
          className={issue.level === 'error' ? styles.lintError : styles.lintWarn}
        >
          <span className={styles.lintLevel}>{issue.level === 'error' ? '错误' : '警告'}</span>
          <span className={styles.lintRule}>{issue.rule}</span>
          <span className={styles.lintMessage}>{issue.message}</span>
        </div>
      ))}
    </div>
  );
}

/** errors 排在 warnings 前面（同级保持原有顺序） */
function sortIssues(issues: LintIssue[]): LintIssue[] {
  return [...issues].sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

function safeFileName(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 40) || 'template';
}

function readMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}