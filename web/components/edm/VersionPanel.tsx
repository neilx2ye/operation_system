'use client';

import { diffLines } from 'diff';
import { useState } from 'react';
import type { TemplateVersion, TemplateVersionMeta, VersionSource } from '@/lib/edm/types';
import styles from './designer.module.css';

export type DiffRow = { left: string | null; right: string | null };

const SOURCE_LABELS: Record<VersionSource, string> = {
  initial: '初始',
  manual: '手动保存',
  import: '导入',
  rollback: '回滚',
  klaviyo: 'Klaviyo',
};

/**
 * 行级差异：先把行内拼接的标签拆成一行一个，再把「删除块 / 新增块」按行配对，
 * 未变化的行两侧同时出现。配对后是左右两列的表格，可直接按行比对。
 */
export function buildDiffRows(oldHtml: string, newHtml: string): DiffRow[] {
  const norm = (s: string) => s.replace(/></g, '>\n<');
  const parts = diffLines(norm(oldHtml), norm(newHtml));
  const rows: DiffRow[] = [];
  let pendingRemoved: string[] = [];
  const flushRemoved = () => {
    for (const line of pendingRemoved) rows.push({ left: line, right: null });
    pendingRemoved = [];
  };
  for (const part of parts) {
    const lines = part.value.replace(/\n$/, '').split('\n');
    if (part.removed) {
      pendingRemoved.push(...lines);
    } else if (part.added) {
      const n = Math.max(pendingRemoved.length, lines.length);
      for (let i = 0; i < n; i++) {
        rows.push({ left: pendingRemoved[i] ?? null, right: lines[i] ?? null });
      }
      pendingRemoved = [];
    } else {
      flushRemoved();
      for (const line of lines) rows.push({ left: line, right: line });
    }
  }
  flushRemoved();
  return rows;
}

export function VersionPanel(props: {
  templateId: string;
  versions: TemplateVersionMeta[];
  currentVersionId: string;
  viewingVersionId: string;
  /** 最新版本的 HTML，用作对比的右侧 */
  currentHtml: string;
  dirty: boolean;
  busy: boolean;
  onSelectVersion: (versionId: string) => void;
  onSave: (note: string) => Promise<boolean>;
  onRollback: (versionId: string) => void;
}): React.ReactElement {
  const [note, setNote] = useState('');
  const [diff, setDiff] = useState<{ meta: TemplateVersionMeta; rows: DiffRow[] } | null>(null);
  const [diffBusyId, setDiffBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ordered = [...props.versions].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
  );

  async function submit(): Promise<void> {
    const ok = await props.onSave(note.trim());
    if (ok) setNote('');
  }

  async function openDiff(meta: TemplateVersionMeta): Promise<void> {
    setError(null);
    setDiffBusyId(meta.id);
    try {
      const res = await fetch(`/api/edm/templates/${props.templateId}/versions/${meta.id}`);
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) throw new Error(readMessage(body, '版本读取失败'));
      const version = (body as { version: TemplateVersion }).version;
      setDiff({ meta, rows: buildDiffRows(version.html, props.currentHtml) });
    } catch (err) {
      setError(err instanceof Error ? err.message : '版本读取失败');
    } finally {
      setDiffBusyId(null);
    }
  }

  return (
    <div className={styles.versionPanel}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>保存新版本</div>
        <div className={styles.rowActions}>
          <input
            className={styles.textInput}
            value={note}
            placeholder="版本备注（可选）"
            onChange={(e) => setNote(e.target.value)}
          />
          <button className={styles.primaryBtn} disabled={!props.dirty || props.busy} onClick={() => void submit()}>
            {props.busy ? '保存中…' : '保存为新版本'}
          </button>
        </div>
        {props.dirty ? (
          <div className={styles.muted}>当前草稿尚未保存，保存后会生成一个新版本。</div>
        ) : (
          <div className={styles.muted}>当前没有未保存的修改。</div>
        )}
      </div>

      {error && <div className={styles.errBox}>{error}</div>}

      <div className={styles.section}>
        <div className={styles.sectionTitle}>版本历史（{ordered.length}）</div>
        <div className={styles.versionList}>
          {ordered.map((version) => {
            const isHead = version.id === props.currentVersionId;
            const isViewing = version.id === props.viewingVersionId;
            return (
              <div
                key={version.id}
                className={isViewing ? `${styles.versionItem} ${styles.versionItemOn}` : styles.versionItem}
              >
                <div className={styles.versionHead}>
                  <b>{isHead ? '最新版本' : `版本 ${shortId(version.id)}`}</b>
                  {isHead && <span className={styles.badgeGreen}>当前</span>}
                  <span className={styles.badge}>{SOURCE_LABELS[version.source] ?? version.source}</span>
                  <span className={styles.muted}>{formatTime(version.createdAt)}</span>
                </div>
                <div className={styles.versionNote}>{version.note || <span className={styles.muted}>（无备注）</span>}</div>
                <div className={styles.versionMeta}>
                  {formatBytes(version.bytes)}
                  {version.fromVersionId ? ` · 回滚自 ${shortId(version.fromVersionId)}` : ''}
                </div>
                <div className={styles.rowActions}>
                  <button
                    className={styles.smallBtn}
                    disabled={isViewing}
                    onClick={() => props.onSelectVersion(version.id)}
                  >
                    {isViewing ? '正在查看' : '查看'}
                  </button>
                  <button
                    className={styles.smallBtn}
                    disabled={isHead || diffBusyId !== null}
                    title={isHead ? '最新版本无需对比' : '与最新版本对比'}
                    onClick={() => void openDiff(version)}
                  >
                    {diffBusyId === version.id ? '读取中…' : '对比'}
                  </button>
                  {!isHead && (
                    <button
                      className={styles.dangerBtn}
                      disabled={props.busy}
                      onClick={() => props.onRollback(version.id)}
                    >
                      回滚
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {diff && (
        <div className={styles.modalMask} onClick={() => setDiff(null)}>
          <div className={`${styles.modal} ${styles.modalWide}`} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHead}>
              <b>版本对比</b>
              <span className={styles.muted}>
                左：{shortId(diff.meta.id)}（{formatTime(diff.meta.createdAt)}） · 右：最新版本
              </span>
              <div className={styles.spacer} />
              <button className={styles.smallBtn} onClick={() => setDiff(null)}>
                关闭
              </button>
            </div>
            <div className={styles.modalBody}>
              {diff.rows.length === 0 ? (
                <div className={styles.emptyBox}>两个版本内容一致。</div>
              ) : (
                <div className={styles.diffWrap}>
                  {diff.rows.map((row, index) => (
                    <div className={styles.diffRow} key={index}>
                      <pre className={`${styles.diffCell} ${row.right === null ? styles.diffDel : ''} ${
                        row.left === null ? styles.diffEmpty : ''
                      }`}>
                        {row.left ?? ''}
                      </pre>
                      <pre className={`${styles.diffCell} ${row.left === null ? styles.diffAdd : ''} ${
                        row.right === null ? styles.diffEmpty : row.left !== row.right ? styles.diffAdd : ''
                      }`}>
                        {row.right ?? ''}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 10)}…` : id;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function readMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}