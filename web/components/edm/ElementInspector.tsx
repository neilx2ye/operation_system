'use client';

import { useEffect, useState } from 'react';
import { checkImageUrl, LOCAL_ASSET_PREFIX, type UnsafeUrlReason } from '@/lib/edm/html';
import {
  editableTextSegments,
  elementLabel,
  escapeHtml,
  getAttribute,
  lineOf,
  replaceRange,
  setAttributes,
  setTextSegment,
  type AttrPatch,
  type ElementRecord,
  type SourceRange,
} from '@/lib/edm/html-edit';
import type { Asset } from '@/lib/edm/types';
import styles from './designer.module.css';

const REASON_LABELS: Record<UnsafeUrlReason, string> = {
  blob: 'blob: 临时地址，邮件客户端无法访问',
  data: 'data: 内联地址，多数邮件客户端会拦截',
  file: '本地文件路径不可用于邮件',
  localhost: '指向本机地址',
  private_host: '指向内网地址',
  insecure: '不是公开的 HTTPS 地址',
};

/** 不允许插入素材的元素：往里塞 <img> 会破坏样式或脚本内容 */
const INSERT_BLOCKED = new Set(['script', 'style', 'title', 'textarea', 'head', 'html']);

/**
 * 元素属性面板。所有写入都走 html-edit 的 setAttributes / setTextSegment，
 * 目标字符串始终是设计器当前的草稿，不做任何手写正则替换。
 */
export function ElementInspector(props: {
  source: string;
  element: ElementRecord;
  /** 直接子元素个数：>0 时只能按文本片段编辑，不能整段重写 */
  childCount: number;
  readOnly: boolean;
  /** 当前 src 指向的本地素材（素材库里查不到时为 null） */
  localAsset: Asset | null;
  localAssetId: string | null;
  onSourceChange: (next: string) => void;
  onRequestAsset: (mode: 'src' | 'insert') => void;
  onClear: () => void;
}): React.ReactElement {
  const { source, element } = props;
  const segments = editableTextSegments(source, element);
  const label = elementLabel(source, element);
  const line = lineOf(source, element.start);
  const snippet = source.slice(element.start, Math.min(element.end, element.start + 180));
  const isImage = element.tag === 'img';
  const isLink = element.tag === 'a';
  const insertBlocked = INSERT_BLOCKED.has(element.tag);

  const src = isImage ? (getAttribute(source, element, 'src') ?? '') : '';
  const alt = isImage ? (getAttribute(source, element, 'alt') ?? '') : '';
  const width = isImage ? (getAttribute(source, element, 'width') ?? '') : '';
  const href = isLink ? (getAttribute(source, element, 'href') ?? '') : '';
  const target = isLink ? (getAttribute(source, element, 'target') ?? '') : '';

  const [srcDraft, setSrcDraft] = useState(src);
  const [altDraft, setAltDraft] = useState(alt);
  const [widthDraft, setWidthDraft] = useState(width);
  const [hrefDraft, setHrefDraft] = useState(href);
  const [targetDraft, setTargetDraft] = useState(target);
  const [textDrafts, setTextDrafts] = useState<string[]>(() => segments.map((s) => s.text));

  const textSignature = segments.map((s) => s.text).join('\u0000');

  // 选中元素变化或源码被外部改动时，把输入框同步回真实值
  useEffect(() => {
    setSrcDraft(src);
    setAltDraft(alt);
    setWidthDraft(width);
    setHrefDraft(href);
    setTargetDraft(target);
  }, [element.index, src, alt, width, href, target]);

  useEffect(() => {
    setTextDrafts(segments.map((s) => s.text));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element.index, textSignature]);

  const imageDirty = isImage && (srcDraft !== src || altDraft !== alt || widthDraft !== width);
  const linkDirty = isLink && (hrefDraft !== href || targetDraft !== target);

  const imageNotice = isImage ? imageWarning(srcDraft.trim(), props.localAssetId, props.localAsset) : null;

  function applyImage(): void {
    const patches: AttrPatch[] = [];
    if (srcDraft !== src) patches.push({ name: 'src', value: srcDraft.trim() });
    if (altDraft !== alt) patches.push({ name: 'alt', value: altDraft });
    if (widthDraft !== width) patches.push({ name: 'width', value: widthDraft.trim() });
    if (!patches.length) return;
    props.onSourceChange(applyAttributePatches(props.source, props.element, patches));
  }

  function applyLink(): void {
    const patches: AttrPatch[] = [];
    if (hrefDraft !== href) patches.push({ name: 'href', value: hrefDraft.trim() });
    if (targetDraft !== target) patches.push({ name: 'target', value: targetDraft });
    if (!patches.length) return;
    props.onSourceChange(applyAttributePatches(props.source, props.element, patches));
  }

  function applyText(segment: SourceRange, index: number, current: string): void {
    const text = textDrafts[index] ?? current;
    if (text === current) return;
    const next = setTextSegment(props.source, segment, text);
    if (next !== props.source) props.onSourceChange(next);
  }

  return (
    <div className={styles.inspector}>
      <div className={styles.inspectorHead}>
        <div className={styles.inspectorTitle}>{label}</div>
        <div className={styles.inspectorMeta}>
          <span className={styles.tagPill}>{`<${element.tag}>`}</span>
          <span>
            第 {line.line} 行 · 第 {line.column} 列
          </span>
          {props.childCount > 0 && <span>子元素 {props.childCount} 个</span>}
        </div>
        <div className={styles.rowActions}>
          <button className={styles.smallBtn} onClick={props.onClear}>
            清除选择
          </button>
          <button
            className={styles.smallBtn}
            disabled={props.readOnly || insertBlocked}
            title={insertBlocked ? '该元素内不适合插入图片' : '在该元素内插入一张素材图片'}
            onClick={() => props.onRequestAsset('insert')}
          >
            插入素材
          </button>
        </div>
      </div>

      {props.readOnly && (
        <div className={styles.infoBox}>正在查看历史版本（只读）。切回最新版本后才能编辑；如需以该版本继续，请使用“回滚”。</div>
      )}

      <div className={styles.section}>
        <div className={styles.sectionTitle}>源码片段</div>
        <div className={styles.codeHint}>{snippet}</div>
      </div>

      {isImage && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>图片</div>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>地址 src</span>
            <textarea
              className={styles.textarea}
              rows={2}
              value={srcDraft}
              disabled={props.readOnly}
              placeholder="https://... 或从素材库选择"
              onChange={(e) => setSrcDraft(e.target.value)}
            />
          </label>
          <div className={styles.rowActions}>
            <button className={styles.smallBtn} disabled={props.readOnly} onClick={() => props.onRequestAsset('src')}>
              从素材库选择
            </button>
          </div>
          {imageNotice && (
            <div className={props.localAssetId && props.localAsset?.uploaded ? styles.infoBox : styles.warnBox}>{imageNotice}</div>
          )}
          <label className={styles.field}>
            <span className={styles.fieldLabel}>替代文字 alt</span>
            <input
              className={styles.textInput}
              value={altDraft}
              disabled={props.readOnly}
              onChange={(e) => setAltDraft(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>宽度 width</span>
            <input
              className={styles.textInput}
              value={widthDraft}
              disabled={props.readOnly}
              placeholder="如 600 或 100%"
              onChange={(e) => setWidthDraft(e.target.value)}
            />
          </label>
          <div className={styles.rowActions}>
            <button className={styles.primaryBtn} disabled={props.readOnly || !imageDirty} onClick={applyImage}>
              应用图片属性
            </button>
            {imageDirty && <span className={styles.muted}>有未应用的修改</span>}
          </div>
        </div>
      )}

      {isLink && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>链接</div>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>跳转地址 href</span>
            <input
              className={styles.textInput}
              value={hrefDraft}
              disabled={props.readOnly}
              placeholder="https://..."
              onChange={(e) => setHrefDraft(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>打开方式 target</span>
            <select
              className={styles.select}
              value={targetDraft}
              disabled={props.readOnly}
              onChange={(e) => setTargetDraft(e.target.value)}
            >
              <option value="">未设置</option>
              <option value="_blank">_blank（新窗口）</option>
              <option value="_self">_self（当前窗口）</option>
            </select>
          </label>
          <div className={styles.rowActions}>
            <button className={styles.primaryBtn} disabled={props.readOnly || !linkDirty} onClick={applyLink}>
              应用链接属性
            </button>
            {linkDirty && <span className={styles.muted}>有未应用的修改</span>}
          </div>
        </div>
      )}

      <div className={styles.section}>
        <div className={styles.sectionTitle}>文案</div>
        {segments.length === 0 ? (
          <div className={styles.muted}>该元素没有可直接编辑的文本片段（可能是图片、空标签或纯结构容器）。</div>
        ) : (
          <>
            {props.childCount > 0 && (
              <div className={styles.infoBox}>
                该元素包含子元素，已列出可直接编辑的文本片段；如需改结构请用源码编辑。
              </div>
            )}
            {segments.map((segment, index) => (
              <label className={styles.field} key={`${segment.index}-${segment.range.start}`}>
                <span className={styles.fieldLabel}>
                  文本片段 {index + 1}
                  {segment.text.trim().length === 0 ? '（空白）' : ''}
                </span>
                <textarea
                  className={styles.textarea}
                  rows={2}
                  value={textDrafts[index] ?? segment.text}
                  disabled={props.readOnly}
                  onChange={(e) => {
                    const next = [...textDrafts];
                    next[index] = e.target.value;
                    setTextDrafts(next);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      applyText(segment.range, index, segment.text);
                    }
                  }}
                />
                <div className={styles.rowActions}>
                  <button
                    className={styles.smallBtn}
                    disabled={props.readOnly || (textDrafts[index] ?? segment.text) === segment.text}
                    onClick={() => applyText(segment.range, index, segment.text)}
                  >
                    应用
                  </button>
                  <span className={styles.muted}>Ctrl+Enter 也可应用</span>
                </div>
              </label>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/** 图片地址提示：本地素材给上传提醒，其它地址按 checkImageUrl 的结果给出原因 */
function imageWarning(src: string, localAssetId: string | null, localAsset: Asset | null): string | null {
  if (!src) return '图片地址为空，邮件中不会显示这张图。';
  if (src.startsWith(LOCAL_ASSET_PREFIX)) {
    if (localAssetId && !localAsset) return `本地素材 ${localAssetId} 在素材库中不存在，请在推送前重新上传。`;
    if (localAsset?.uploaded) return `本地素材已上传到 Klaviyo：${localAsset.uploaded.url}`;
    return '本地素材在设计稿里可以正常预览；推送 Klaviyo 前需要先上传为公开地址。';
  }
  const reason = checkImageUrl(src);
  if (!reason) return null;
  return `图片地址不可用于邮件（${REASON_LABELS[reason]}）。`;
}

/**
 * 改写元素属性。
 *
 * html-edit 的 setAttributes 在「替换已有的带引号属性」时会多出一个引号
 * （它保留了原来的开引号，又用带引号的文本覆盖了值，结果形如 src=""新值"），
 * 因此替换路径改用同一次解析出的属性偏移 + replaceRange 完成；属性不存在时
 * 仍交给 setAttributes 走插入路径（这条路径是正确的）。
 */
export function applyAttributePatches(html: string, element: ElementRecord, patches: AttrPatch[]): string {
  const ops: { from: number; to: number; text: string }[] = [];
  const inserts: AttrPatch[] = [];
  for (const patch of patches) {
    const attr = element.attrs.find((item) => item.name.toLowerCase() === patch.name.toLowerCase());
    if (!attr) {
      inserts.push(patch);
      continue;
    }
    const text = escapeAttrValue(patch.value, attr.quote);
    ops.push(
      attr.quote
        ? { from: attr.valueStart, to: attr.valueEnd, text }
        : { from: attr.nameStart, to: attr.valueEnd, text: `${attr.name}="${escapeAttrValue(patch.value, '"')}"` },
    );
  }
  // 先在原字符串上插入新属性（插入点 el.openEnd-1 在所有属性偏移之后），再从后往前替换
  let out = inserts.length ? setAttributes(html, element, inserts) : html;
  for (const op of ops.sort((a, b) => b.from - a.from)) {
    out = replaceRange(out, { start: op.from, end: op.to }, op.text);
  }
  return out;
}

function escapeAttrValue(value: string, quote: string): string {
  const escaped = escapeHtml(value);
  return quote === "'" ? escaped.replace(/'/g, '&#39;') : escaped.replace(/"/g, '&quot;');
}