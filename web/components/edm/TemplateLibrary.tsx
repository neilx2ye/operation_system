'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MAX_HTML_BYTES } from '@/lib/edm/html';
import type { CreateTemplateInput, Template, TemplateCategory, TemplateVersionMeta } from '@/lib/edm/types';
import { useHotReload } from '@/lib/useHotReload';
import styles from './TemplateLibrary.module.css';

type TemplateListResponse = { templates: Template[]; categories: TemplateCategory[] };
/** 新建与复制都返回新模板及其第一个版本 */
type TemplateWriteResponse = { template: Template; version: TemplateVersionMeta };
type CategoryResponse = { category: TemplateCategory };
type OkResponse = { ok: true };
type Notice = { ok: boolean; text: string };
type CreatorMode = 'new' | 'import';

/** /api/edm 的错误响应统一为 { code, message, retryable }，页面只展示 message */
async function responseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body.message === 'string' && body.message.trim()) return body.message;
  } catch {
    // 响应不是 JSON 时退回通用文案
  }
  return `请求失败（HTTP ${res.status}）`;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(await responseError(res));
  return (await res.json()) as T;
}

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day} 天前`;
  return formatDate(iso).slice(0, 10);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const MAX_HTML_KB = Math.round(MAX_HTML_BYTES / 1024);

export function TemplateLibrary() {
  const router = useRouter();
  const { version } = useHotReload();

  const [templates, setTemplates] = useState<Template[]>([]);
  const [categories, setCategories] = useState<TemplateCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [creator, setCreator] = useState<CreatorMode | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [formCategory, setFormCategory] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [pastedHtml, setPastedHtml] = useState('');
  const [creating, setCreating] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [showCategories, setShowCategories] = useState(false);
  const [catName, setCatName] = useState('');
  const [catBusy, setCatBusy] = useState(false);

  // 只接受最后一次请求的结果，避免快速切换筛选时旧响应覆盖新数据
  const seq = useRef(0);

  // 成功提示 4 秒后自动消失；错误提示保留，需手动关闭
  useEffect(() => {
    if (!notice || !notice.ok) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // 弹窗打开时按 Esc 关闭（提交中不允许关闭）
  useEffect(() => {
    if (!creator) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !creating) {
        setCreator(null);
        setFormError(null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [creator, creating]);

  // 名称搜索防抖 250ms，避免每敲一个字都请求服务端
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(q.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [q]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (categoryId) params.set('categoryId', categoryId);
      const suffix = params.toString();
      const data = await requestJson<TemplateListResponse>(`/api/edm/templates${suffix ? `?${suffix}` : ''}`);
      if (mine !== seq.current) return;
      setTemplates(data.templates);
      setCategories(data.categories);
      setLoadError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setLoadError(errorText(e, '模板列表加载失败'));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [query, categoryId]);

  useEffect(() => {
    void load();
    // version 变化表示开发服务器已更新数据层，重新取数；页面筛选状态不受影响
  }, [load, version]);

  const categoryNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of categories) map.set(c.id, c.name);
    return map;
  }, [categories]);

  const hasFilter = query !== '' || categoryId !== null;
  const chipClass = (on: boolean) => (on ? `${styles.chip} ${styles.chipOn}` : styles.chip);

  function openCreator(mode: CreatorMode) {
    setCreator(mode);
    setFormError(null);
    setName('');
    setFormCategory(categoryId ?? '');
    setFile(null);
    setPastedHtml('');
    if (fileRef.current) fileRef.current.value = '';
  }

  function closeCreator() {
    if (creating) return;
    setCreator(null);
    setFormError(null);
  }

  function pickFile(next: File | null) {
    setFile(next);
    // 名称为空时用文件名做默认值，用户可以再改
    if (next && !name.trim()) setName(next.name.replace(/\.html?$/i, ''));
  }

  async function submitCreator() {
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError('请输入模板名称');
      return;
    }
    let body: CreateTemplateInput = { name: trimmed, categoryId: formCategory || null };
    if (creator === 'import') {
      if (file && file.size > MAX_HTML_BYTES) {
        setFormError(`文件「${file.name}」为 ${formatBytes(file.size)}，超过 ${MAX_HTML_KB} KB 上限，请精简后再导入`);
        return;
      }
      let html = pastedHtml;
      if (file) {
        try {
          html = await file.text();
        } catch {
          setFormError('读取文件失败，请重新选择文件');
          return;
        }
      }
      if (!html.trim()) {
        setFormError('请选择 .html 文件，或粘贴 HTML 代码');
        return;
      }
      const bytes = new TextEncoder().encode(html).byteLength;
      if (bytes > MAX_HTML_BYTES) {
        setFormError(`HTML 内容为 ${formatBytes(bytes)}，超过 ${MAX_HTML_KB} KB 上限，请精简后再导入`);
        return;
      }
      body = { ...body, html, origin: 'import', note: '导入 HTML' };
    }
    setCreating(true);
    setFormError(null);
    try {
      const data = await requestJson<TemplateWriteResponse>('/api/edm/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      router.push(`/edm/templates/${data.template.id}`);
    } catch (e) {
      setFormError(errorText(e, '创建失败，请重试'));
    } finally {
      setCreating(false);
    }
  }

  async function duplicateTemplate(t: Template) {
    const input = window.prompt('请输入副本名称', `${t.name} (副本)`);
    if (input === null) return;
    const next = input.trim() || `${t.name} (副本)`;
    setBusy(`${t.id}:copy`);
    setNotice(null);
    try {
      await requestJson<TemplateWriteResponse>(`/api/edm/templates/${t.id}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: next }),
      });
      setNotice({ ok: true, text: `已复制为「${next}」` });
      await load();
    } catch (e) {
      setNotice({ ok: false, text: errorText(e, '复制失败，请重试') });
    } finally {
      setBusy(null);
    }
  }

  async function deleteTemplate(t: Template) {
    if (!window.confirm(`删除模板「${t.name}」？本地版本与内容将一并删除，且不可恢复。`)) return;
    setBusy(`${t.id}:delete`);
    setNotice(null);
    try {
      await requestJson<OkResponse>(`/api/edm/templates/${t.id}`, { method: 'DELETE' });
      setNotice({ ok: true, text: `已删除模板「${t.name}」` });
      await load();
    } catch (e) {
      setNotice({ ok: false, text: errorText(e, '删除失败，请重试') });
    } finally {
      setBusy(null);
    }
  }

  async function addCategory() {
    const trimmed = catName.trim();
    if (!trimmed) {
      setNotice({ ok: false, text: '请输入分类名称' });
      return;
    }
    setCatBusy(true);
    setNotice(null);
    try {
      await requestJson<CategoryResponse>('/api/edm/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      setCatName('');
      setNotice({ ok: true, text: `已创建分类「${trimmed}」` });
      await load();
    } catch (e) {
      setNotice({ ok: false, text: errorText(e, '创建分类失败，请重试') });
    } finally {
      setCatBusy(false);
    }
  }

  async function deleteCategory(c: TemplateCategory) {
    if (!window.confirm(`删除分类「${c.name}」？仍被模板使用的分类会被服务端拒绝删除。`)) return;
    setCatBusy(true);
    setNotice(null);
    try {
      await requestJson<OkResponse>(`/api/edm/categories/${c.id}`, { method: 'DELETE' });
      setNotice({ ok: true, text: `已删除分类「${c.name}」` });
      await load();
    } catch (e) {
      // 分类仍被引用时服务端返回 409，直接展示服务端文案
      setNotice({ ok: false, text: errorText(e, '删除分类失败，请重试') });
    } finally {
      setCatBusy(false);
    }
  }

  return (
    <div className={styles.lib}>
      <div className={styles.head}>
        <div className={styles.headText}>
          <h2 className={styles.title}>邮件模板库</h2>
          <p className={styles.sub}>
            本地优先：模板、版本与素材只保存在 OPS 本地，不读取也不写入旧 EDM 数据库。点击任意一行即可打开设计器。
          </p>
        </div>
        <div className={styles.headActions}>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => openCreator('new')}>
            + 新建模板
          </button>
          <button type="button" className={styles.btn} onClick={() => openCreator('import')}>
            导入 HTML
          </button>
        </div>
      </div>

      {notice && (
        <div className={notice.ok ? styles.noticeOk : styles.noticeErr} role={notice.ok ? 'status' : 'alert'}>
          <span className={styles.noticeText}>{notice.text}</span>
          <button type="button" className={styles.noticeClose} aria-label="关闭提示" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}

      <section className={styles.panel}>
        <div className={styles.filters}>
          <input
            className={styles.search}
            type="search"
            value={q}
            placeholder="搜索模板名称 / 主题"
            onChange={(e) => setQ(e.target.value)}
          />
          <div className={styles.chips}>
            <button type="button" className={chipClass(categoryId === null)} onClick={() => setCategoryId(null)}>
              全部
            </button>
            {categories.map((c) => (
              <button
                key={c.id}
                type="button"
                className={chipClass(categoryId === c.id)}
                onClick={() => setCategoryId(categoryId === c.id ? null : c.id)}
              >
                {c.name}
              </button>
            ))}
            <button
              type="button"
              className={styles.linkBtn}
              aria-expanded={showCategories}
              onClick={() => setShowCategories((v) => !v)}
            >
              {showCategories ? '收起分类管理' : categories.length === 0 ? '+ 创建分类' : '管理分类'}
            </button>
          </div>
          <span className={styles.spacer} />
          <span className={styles.count}>{loading ? '加载中…' : `共 ${templates.length} 个模板`}</span>
          <button type="button" className={styles.linkBtn} disabled={loading} onClick={() => void load()}>
            刷新
          </button>
        </div>

        {showCategories && (
          <div className={styles.catBody}>
            {categories.length === 0 ? (
              <div className={styles.muted}>暂无分类，在下方输入名称即可创建</div>
            ) : (
              <div className={styles.catList}>
                {categories.map((c) => (
                  <span key={c.id} className={styles.catItem}>
                    <span className={styles.catName}>{c.name}</span>
                    <button
                      type="button"
                      className={styles.catRemove}
                      disabled={catBusy}
                      aria-label={`删除分类 ${c.name}`}
                      title="删除分类"
                      onClick={() => void deleteCategory(c)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className={styles.catAdd}>
              <input
                className={styles.input}
                type="text"
                value={catName}
                maxLength={60}
                placeholder="新分类名称，回车添加"
                onChange={(e) => setCatName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) void addCategory();
                }}
              />
              <button type="button" className={styles.btn} disabled={catBusy || !catName.trim()} onClick={() => void addCategory()}>
                {catBusy ? '处理中…' : '添加'}
              </button>
            </div>
          </div>
        )}

        {loadError ? (
          <div className={styles.stateBox}>
            <div className={styles.stateErr}>{loadError}</div>
            <button type="button" className={styles.btn} onClick={() => void load()}>
              重试
            </button>
          </div>
        ) : loading && templates.length === 0 ? (
          <div className={styles.stateBox}>加载中…</div>
        ) : templates.length === 0 ? (
          <div className={styles.stateBox}>
            <div className={styles.stateTitle}>{hasFilter ? '没有符合条件的模板' : '还没有模板'}</div>
            <div className={styles.muted}>{hasFilter ? '试试更换关键词或分类' : '从空白新建，或导入已有的 HTML 邮件'}</div>
            <div className={styles.emptyActions}>
              {hasFilter && (
                <button
                  type="button"
                  className={styles.btn}
                  onClick={() => {
                    setQ('');
                    setCategoryId(null);
                  }}
                >
                  清除筛选
                </button>
              )}
              <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => openCreator('new')}>
                新建模板
              </button>
              <button type="button" className={styles.btn} onClick={() => openCreator('import')}>
                导入 HTML
              </button>
            </div>
          </div>
        ) : (
          <div className={loading ? `${styles.tableWrap} ${styles.tableBusy}` : styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>模板</th>
                  <th>分类</th>
                  <th>状态</th>
                  <th className={styles.num}>版本</th>
                  <th>最近更新</th>
                  <th className={styles.actionsCol}>操作</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => (
                  <tr
                    key={t.id}
                    className={styles.row}
                    tabIndex={0}
                    onClick={() => router.push(`/edm/templates/${t.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.target === e.currentTarget) router.push(`/edm/templates/${t.id}`);
                    }}
                  >
                    <td className={styles.nameTd}>
                      <div className={styles.name}>{t.name}</div>
                      <div className={styles.subject}>{t.subject ? t.subject : '未设置邮件主题'}</div>
                    </td>
                    <td>
                      {t.categoryId ? (
                        (categoryNames.get(t.categoryId) ?? <span className={styles.muted}>未知分类</span>)
                      ) : (
                        <span className={styles.muted}>未分类</span>
                      )}
                    </td>
                    <td>
                      {t.remote ? (
                        <span className={styles.tagGreen}>已绑定 Klaviyo</span>
                      ) : (
                        <span className={styles.tagGrey}>仅本地</span>
                      )}
                    </td>
                    <td className={`${styles.num} ${styles.muted}`} title="每次保存 +1，正常情况下等于本地版本数">
                      v{t.revision}
                    </td>
                    <td className={styles.muted} title={formatDate(t.updatedAt)}>
                      {formatRelative(t.updatedAt)}
                    </td>
                    <td className={styles.actionsCol}>
                      <span className={styles.rowActions}>
                        <button
                          type="button"
                          className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            router.push(`/edm/templates/${t.id}`);
                          }}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          className={`${styles.btn} ${styles.btnSmall}`}
                          disabled={busy === `${t.id}:copy`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void duplicateTemplate(t);
                          }}
                        >
                          {busy === `${t.id}:copy` ? '复制中…' : '复制'}
                        </button>
                        <button
                          type="button"
                          className={`${styles.btn} ${styles.btnSmall} ${styles.btnDanger}`}
                          disabled={busy === `${t.id}:delete`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void deleteTemplate(t);
                          }}
                        >
                          删除
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {creator && (
        <div
          className={styles.overlay}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeCreator();
          }}
        >
          <div className={styles.modal} role="dialog" aria-modal="true" aria-label={creator === 'new' ? '新建模板' : '导入 HTML'}>
            <div className={styles.modalHead}>
              <div className={styles.tabs} role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={creator === 'new'}
                  className={creator === 'new' ? `${styles.tab} ${styles.tabOn}` : styles.tab}
                  disabled={creating}
                  onClick={() => setCreator('new')}
                >
                  空白新建
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={creator === 'import'}
                  className={creator === 'import' ? `${styles.tab} ${styles.tabOn}` : styles.tab}
                  disabled={creating}
                  onClick={() => setCreator('import')}
                >
                  导入 HTML
                </button>
              </div>
              <button type="button" className={styles.noticeClose} aria-label="关闭" disabled={creating} onClick={closeCreator}>
                ×
              </button>
            </div>

            <div className={styles.modalBody}>
              <div className={styles.hint}>
                {creator === 'new'
                  ? '创建后直接进入设计器编辑内容'
                  : `选择 .html 文件或粘贴代码，单个文件不超过 ${MAX_HTML_KB} KB`}
              </div>
              {formError && <div className={styles.formError}>{formError}</div>}
              <div className={styles.formRow}>
                <label className={styles.field}>
                  <span className={styles.label}>模板名称</span>
                  <input
                    className={styles.input}
                    type="text"
                    value={name}
                    maxLength={120}
                    autoFocus
                    placeholder="例如：夏季促销邮件"
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing && creator === 'new') void submitCreator();
                    }}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>分类（可选）</span>
                  <select className={styles.select} value={formCategory} onChange={(e) => setFormCategory(e.target.value)}>
                    <option value="">未分类</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {creator === 'import' && (
                <>
                  <label className={styles.field}>
                    <span className={styles.label}>
                      HTML 文件{file ? `（已选择：${file.name}，${formatBytes(file.size)}）` : ''}
                    </span>
                    <input
                      ref={fileRef}
                      className={styles.file}
                      type="file"
                      accept=".html,.htm,text/html"
                      onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                    />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.label}>或粘贴 HTML 代码{file ? '（已选择文件时以文件内容为准）' : ''}</span>
                    <textarea
                      className={styles.textarea}
                      rows={8}
                      value={pastedHtml}
                      spellCheck={false}
                      placeholder="<!doctype html> ..."
                      onChange={(e) => setPastedHtml(e.target.value)}
                    />
                  </label>
                </>
              )}
            </div>

            <div className={styles.modalFoot}>
              <button type="button" className={styles.btn} disabled={creating} onClick={closeCreator}>
                取消
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={creating}
                onClick={() => void submitCreator()}
              >
                {creating ? (creator === 'import' ? '导入中…' : '创建中…') : creator === 'import' ? '导入并打开设计器' : '创建并打开设计器'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
