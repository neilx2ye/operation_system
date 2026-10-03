'use client';

import { useCallback, useEffect, useRef } from 'react';
import { PREVIEW_SANDBOX } from '@/lib/edm/html-edit';
import styles from './designer.module.css';

const SELECTED_CLASS = '__edm-selected';
const STYLE_MARK = 'data-edm-preview-style';

/**
 * 预览框。sandbox 只开 allow-same-origin（绝不开 allow-scripts）：
 * 模板里的脚本一律不会执行，但宿主仍能读取 contentDocument 注入事件，
 * 因此这里不需要 postMessage。
 *
 * 首次渲染与切换版本用 srcDoc（外层用 frameKey 强制重建文档）；
 * 打字过程中的草稿走 doc.open/write/close 重写既有文档，避免每个按键都重建 iframe。
 */
export function PreviewFrame(props: {
  /** 版本 id：变化时重建文档 */
  frameKey: string;
  /** 预览 HTML（已注入 data-edm-el，并移除了 script 与 on* 事件属性） */
  html: string;
  mode: 'desktop' | 'mobile';
  zoom: number;
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
}): React.ReactElement {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  /** 当前文档里已有的内容；与 props.html 相同则不需要重写 */
  const writtenRef = useRef<string>(props.html);
  const htmlRef = useRef<string>(props.html);
  const selectedRef = useRef<number | null>(props.selectedIndex);
  const onSelectRef = useRef(props.onSelect);
  const initialRef = useRef<{ key: string; html: string }>({ key: props.frameKey, html: props.html });

  // 版本切换：为新的文档准备初始内容（srcDoc 只在这里更新，之后靠 doc.write）
  if (initialRef.current.key !== props.frameKey) {
    initialRef.current = { key: props.frameKey, html: props.html };
    writtenRef.current = props.html;
  }
  selectedRef.current = props.selectedIndex;
  onSelectRef.current = props.onSelect;

  const syncSelected = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    for (const el of Array.from(doc.querySelectorAll(`.${SELECTED_CLASS}`))) {
      el.classList.remove(SELECTED_CLASS);
    }
    const index = selectedRef.current;
    if (index === null) return;
    const target = doc.querySelector(`[data-edm-el="${index}"]`);
    target?.classList.add(SELECTED_CLASS);
  }, []);

  const attach = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    cleanupRef.current?.();
    cleanupRef.current = null;
    injectPreviewStyle(doc);

    const onClick = (event: MouseEvent) => {
      // 预览里的链接/表单不允许真的跳转或提交
      event.preventDefault();
      event.stopPropagation();
      onSelectRef.current(elementIndexFromEvent(event));
    };
    const onSubmit = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const onAuxClick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };

    doc.addEventListener('click', onClick, true);
    doc.addEventListener('submit', onSubmit, true);
    doc.addEventListener('auxclick', onAuxClick, true);
    cleanupRef.current = () => {
      doc.removeEventListener('click', onClick, true);
      doc.removeEventListener('submit', onSubmit, true);
      doc.removeEventListener('auxclick', onAuxClick, true);
    };
    syncSelected();
  }, [syncSelected]);

  const writeDocument = useCallback(
    (html: string) => {
      const doc = frameRef.current?.contentDocument;
      if (!doc) return;
      writtenRef.current = html;
      doc.open();
      doc.write(html);
      doc.close();
      // doc.write 会清掉注入的监听与样式，必须重新绑定
      attach();
    },
    [attach],
  );

  useEffect(() => {
    htmlRef.current = props.html;
  }, [props.html]);

  useEffect(() => {
    if (props.html === writtenRef.current) return;
    writeDocument(props.html);
  }, [props.html, writeDocument]);

  useEffect(() => {
    syncSelected();
  }, [props.selectedIndex, props.html, props.frameKey, syncSelected]);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);

  const scale = props.zoom / 100;

  return (
    <div className={styles.previewStage}>
      <div className={styles.previewInner} style={{ width: props.mode === 'mobile' ? 375 : '100%' }}>
        <div
          className={styles.previewScaler}
          style={{ transform: `scale(${scale})`, transformOrigin: 'top center', height: `${100 / scale}%` }}
        >
          <iframe
            key={props.frameKey}
            ref={frameRef}
            className={styles.frame}
            sandbox={PREVIEW_SANDBOX}
            srcDoc={initialRef.current.html}
            title={`模板预览 ${props.frameKey}`}
            onLoad={() => {
              // srcDoc 装载完成：记录文档内容，并补上装载期间可能已经变化的草稿
              writtenRef.current = initialRef.current.html;
              attach();
              if (htmlRef.current !== writtenRef.current) writeDocument(htmlRef.current);
            }}
          />
        </div>
      </div>
    </div>
  );
}

/** 从事件目标向上找到最近的 data-edm-el 元素，取出元素序号 */
function elementIndexFromEvent(event: MouseEvent): number | null {
  const raw = event.target as Node | null;
  if (!raw) return null;
  const start = raw.nodeType === 1 ? (raw as Element) : raw.parentElement;
  const host = start?.closest?.('[data-edm-el]') ?? null;
  if (!host) return null;
  const attr = host.getAttribute('data-edm-el');
  if (attr === null) return null;
  const index = Number(attr);
  if (!Number.isInteger(index) || index < 0) return null;
  return index;
}

/** 注入预览交互样式；不影响源码，也不改变元素盒模型 */
function injectPreviewStyle(doc: Document): void {
  if (!doc.head) return;
  if (doc.head.querySelector(`style[${STYLE_MARK}]`)) return;
  const style = doc.createElement('style');
  style.setAttribute(STYLE_MARK, '1');
  style.textContent = [
    '[data-edm-el]{cursor:pointer}',
    '[data-edm-el]:hover{outline:2px dashed #3b82f6;outline-offset:-2px}',
    `[data-edm-el].${SELECTED_CLASS}{outline:2px solid #2563eb;outline-offset:-2px}`,
  ].join('\n');
  doc.head.appendChild(style);
}