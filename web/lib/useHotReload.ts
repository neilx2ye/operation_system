'use client';

import { useEffect, useState } from 'react';

export type HotReloadStatus = 'off' | 'connecting' | 'live';

/**
 * 订阅开发服务器的热重载事件。
 * version 每次变化表示数据层已更新，视图中把它放进 useEffect 依赖即可自动重新取数，
 * 页面状态（筛选、排序、选中的行）不会被重置。
 */
export function useHotReload(): { version: number; status: HotReloadStatus } {
  const dev = process.env.NODE_ENV === 'development';
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<HotReloadStatus>(dev ? 'connecting' : 'off');

  useEffect(() => {
    if (!dev) return;
    const es = new EventSource('/api/hot-reload');
    let fallback: ReturnType<typeof setTimeout>;

    es.onopen = () => setStatus('live');
    es.onerror = () => setStatus('connecting');
    es.onmessage = (e) => {
      let payload: { type?: string };
      try {
        payload = JSON.parse(e.data);
      } catch {
        return;
      }
      if (payload.type !== 'reload') return;
      setVersion((v) => v + 1);
      // 兜底：服务端重新编译可能略慢于文件事件，稍后再取一次。
      clearTimeout(fallback);
      fallback = setTimeout(() => setVersion((v) => v + 1), 1200);
    };

    return () => {
      clearTimeout(fallback);
      es.close();
    };
  }, [dev]);

  return { version, status };
}