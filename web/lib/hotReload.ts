// 开发期热重载（服务端）：监听数据层目录的文件变化，把「数据已更新」推送给浏览器。
// 只在开发模式启用；生产模式下 subscribeHotReload 不会启动任何监听。
import { existsSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

/** 需要监听的数据层目录（相对 web/），不存在的目录会被跳过 */
const WATCH_DIRS = ['lib', 'data'];
/** 文件连续写入时合并成一次通知 */
const DEBOUNCE_MS = 400;

export type ReloadEvent = { file: string; at: number };

type Listener = (event: ReloadEvent) => void;

type Hub = {
  listeners: Set<Listener>;
  watchers: FSWatcher[];
  timer: NodeJS.Timeout | null;
  pending: string | null;
};

// 模块热更新会重新执行本文件，用 globalThis 保持监听器与 watcher 是单例。
const HUB_KEY = Symbol.for('ops.hotReload.hub');

function hub(): Hub {
  const g = globalThis as typeof globalThis & { [HUB_KEY]?: Hub };
  g[HUB_KEY] ??= { listeners: new Set(), watchers: [], timer: null, pending: null };
  return g[HUB_KEY];
}

export function hotReloadEnabled(): boolean {
  return process.env.NODE_ENV !== 'production';
}

function flush(h: Hub) {
  const file = h.pending;
  h.pending = null;
  h.timer = null;
  if (!file || h.listeners.size === 0) return;
  const event: ReloadEvent = { file, at: Date.now() };
  h.listeners.forEach((listener) => {
    try {
      listener(event);
    } catch {
      /* 单个连接出错不影响其他连接 */
    }
  });
}

function stopWatching(h: Hub) {
  h.watchers.forEach((watcher) => watcher.close());
  h.watchers = [];
  if (h.timer) clearTimeout(h.timer);
  h.timer = null;
  h.pending = null;
}

function ensureWatching(h: Hub) {
  if (h.watchers.length > 0 || !hotReloadEnabled()) return;
  WATCH_DIRS.map((dir) => path.join(process.cwd(), dir))
    .filter(existsSync)
    .forEach((root) => {
      try {
        const watcher = watch(root, { recursive: true }, (_eventType, file) => {
          if (!file) return;
          const name = path.basename(file);
          if (name.startsWith('.') || name.endsWith('.tsbuildinfo') || name.endsWith('.log')) return;
          h.pending = file.split(path.sep).join('/');
          if (h.timer) clearTimeout(h.timer);
          h.timer = setTimeout(() => flush(h), DEBOUNCE_MS);
        });
        watcher.on('error', () => stopWatching(h));
        h.watchers.push(watcher);
      } catch {
        /* 目录不存在或不可监听时跳过 */
      }
    });
}

/** 订阅数据层变化；返回取消订阅函数。首个订阅者出现时才开始监听目录。 */
export function subscribeHotReload(listener: Listener): () => void {
  if (!hotReloadEnabled()) return () => {};
  const h = hub();
  ensureWatching(h);
  h.listeners.add(listener);
  return () => {
    h.listeners.delete(listener);
    if (h.listeners.size === 0) stopWatching(h);
  };
}