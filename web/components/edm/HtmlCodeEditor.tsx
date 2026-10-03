'use client';

import { html as htmlLanguage } from '@codemirror/lang-html';
import { EditorView } from '@codemirror/view';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LOCAL_ASSET_PREFIX } from '@/lib/edm/html';
import type { SourceRange } from '@/lib/edm/html-edit';
import type { Asset } from '@/lib/edm/types';
// js-beautify 1.15 未附带类型声明，运行时通过 CJS 默认导出取 html()。
// @ts-ignore js-beautify 没有类型声明文件
import jsBeautify from 'js-beautify';
import styles from './designer.module.css';

/** 格式化选项：与旧设计器的策略保持一致，压缩空行、不重排 pre/textarea 等原始文本元素 */
const BEAUTIFY_OPTIONS: Record<string, unknown> = {
  indent_size: 2,
  indent_char: ' ',
  wrap_line_length: 0,
  preserve_newlines: false,
  max_preserve_newlines: 1,
  extra_liners: [],
  unformatted: ['pre', 'textarea', 'code', 'style', 'script'],
  content_unformatted: ['pre', 'textarea', 'code', 'style', 'script'],
};

type EditorStatus = { kind: 'ok' | 'err'; text: string };

export function HtmlCodeEditor(props: {
  value: string;
  onChange: (next: string) => void;
  readOnly: boolean;
  /** 预览里选中的元素对应的源码范围；变化时高亮但不抢焦点 */
  selectionRange: SourceRange | null;
  /** 选中标记：只在真正切换选中元素/版本时重新高亮，避免打字时反复挪动光标 */
  selectionToken: string | null;
  /** 导出文件名 */
  fileName: string;
  /** 上传剪贴板图片，返回素材记录；失败时抛错 */
  onUploadImage: (file: File) => Promise<Asset>;
}): React.ReactElement {
  const editorRef = useRef<ReactCodeMirrorRef | null>(null);
  const rangeRef = useRef<SourceRange | null>(props.selectionRange);
  const [status, setStatus] = useState<EditorStatus | null>(null);
  const [uploading, setUploading] = useState(false);
  const ctxRef = useRef({ readOnly: props.readOnly, upload: props.onUploadImage });
  rangeRef.current = props.selectionRange;

  useEffect(() => {
    ctxRef.current = { readOnly: props.readOnly, upload: props.onUploadImage };
  }, [props.readOnly, props.onUploadImage]);

  useEffect(() => {
    if (!status || status.kind !== 'ok') return;
    const timer = window.setTimeout(() => setStatus(null), 2000);
    return () => window.clearTimeout(timer);
  }, [status]);

  // 选中元素 → 高亮源码范围。不调用 view.focus()：那会把焦点从预览里的
  // 就地编辑抢走，导致编辑提前结束。
  useEffect(() => {
    const view = editorRef.current?.view;
    const range = rangeRef.current;
    if (!view || !range) return;
    const length = view.state.doc.length;
    view.dispatch({
      selection: {
        anchor: Math.min(Math.max(0, range.start), length),
        head: Math.min(Math.max(0, range.end), length),
      },
      scrollIntoView: true,
    });
  }, [props.selectionToken]);

  const pasteExtension = useMemo(
    () =>
      EditorView.domEventHandlers({
        paste: (event, view) => {
          const file = imageFileFromClipboard(event.clipboardData);
          if (!file) return false;
          event.preventDefault();
          const ctx = ctxRef.current;
          if (ctx.readOnly) {
            setStatus({ kind: 'err', text: '只读模式下无法插入图片' });
            return true;
          }
          const { from, to } = view.state.selection.main;
          setUploading(true);
          setStatus(null);
          void ctx
            .upload(file)
            .then((asset) => {
              view.dispatch({
                changes: { from, to, insert: imageTag(`${LOCAL_ASSET_PREFIX}${asset.id}`, asset.filename) },
              });
              setStatus({ kind: 'ok', text: `已插入素材 ${asset.filename}` });
            })
            .catch((err: unknown) => {
              setStatus({ kind: 'err', text: err instanceof Error ? err.message : '图片上传失败' });
            })
            .finally(() => setUploading(false));
          return true;
        },
      }),
    [],
  );

  const extensions = useMemo(() => [htmlLanguage(), pasteExtension], [pasteExtension]);

  const format = useCallback(() => {
    if (props.readOnly) return;
    try {
      const next = beautifyHtml(props.value);
      if (next === props.value) {
        setStatus({ kind: 'ok', text: '源码已是格式化状态（仍标记为未保存）' });
      } else {
        setStatus({ kind: 'ok', text: '已格式化，保存前请确认渲染效果' });
      }
      props.onChange(next);
    } catch (err) {
      setStatus({ kind: 'err', text: err instanceof Error ? err.message : '格式化失败' });
    }
  }, [props]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(props.value);
      setStatus({ kind: 'ok', text: '源码已复制到剪贴板' });
    } catch {
      setStatus({ kind: 'err', text: '复制失败：浏览器拒绝了剪贴板访问' });
    }
  }, [props.value]);

  const exportHtml = useCallback(() => {
    const blob = new Blob([props.value], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = props.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus({ kind: 'ok', text: `已导出 ${props.fileName}` });
  }, [props.value, props.fileName]);

  return (
    <div className={styles.editorWrap}>
      <div className={styles.editorBar}>
        <button className={styles.smallBtn} onClick={format} disabled={props.readOnly || uploading}>
          格式化
        </button>
        <button className={styles.smallBtn} onClick={() => void copy()} disabled={uploading}>
          复制源码
        </button>
        <button className={styles.smallBtn} onClick={exportHtml} disabled={uploading}>
          导出 HTML
        </button>
        <div className={styles.spacer} />
        {uploading && <span className={styles.muted}>图片上传中…</span>}
      </div>
      <div className={styles.editorBody}>
        <CodeMirror
          ref={editorRef}
          value={props.value}
          onChange={(value) => props.onChange(value)}
          height="100%"
          theme="light"
          readOnly={props.readOnly}
          editable={!props.readOnly}
          extensions={extensions}
          basicSetup={{
            foldGutter: false,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
            autocompletion: false,
          }}
        />
      </div>
      <div className={styles.editorStatus}>
        {status ? (
          <span className={status.kind === 'ok' ? styles.statusOk : styles.statusErr}>{status.text}</span>
        ) : (
          <span className={styles.muted}>可直接粘贴图片（Ctrl+V）上传到素材库并插入；格式化只在你点击时执行。</span>
        )}
      </div>
    </div>
  );
}

function beautifyHtml(source: string): string {
  return jsBeautify.html(source, BEAUTIFY_OPTIONS) as string;
}

/** 从剪贴板里取出第一张图片文件 */
function imageFileFromClipboard(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const item of Array.from(data.items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

function imageTag(url: string, alt: string): string {
  const safeAlt = alt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<img src="${url}" alt="${safeAlt}" />`;
}