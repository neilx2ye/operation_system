'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KlaviyoMarketingStatus } from '@/lib/edm/types';

// 列表页只读取 OPS 本地缓存（/profiles/status 不访问 Klaviyo），
// 并且一次批量请求 + 分片，绝不逐行发请求、也不做任何轮询。

const CHUNK_SIZE = 200;
const MAX_IDS = 1000;
const DEBOUNCE_MS = 300;

export type MarketingStatusMap = Record<string, KlaviyoMarketingStatus>;

type StatusResponse = {
  accountId: string | null;
  storeKey: string;
  matched: number;
  unknown: number;
  statuses: MarketingStatusMap;
};

/** 统一读取错误响应里的 message（/api 的错误体都是 { code, message, retryable }） */
export async function readApiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown; code?: unknown };
    if (typeof body.message === 'string' && body.message.trim()) return body.message;
    if (typeof body.code === 'string' && body.code.trim()) return `请求失败（${body.code}）`;
  } catch {
    // 响应不是 JSON 时退回通用文案
  }
  return `请求失败（HTTP ${res.status}）`;
}

export function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/**
 * 批量读取可见客户的营销状态缓存。
 * - ids 去重后按 ≤200 分片发送；
 * - 内容不变时不会重复请求（用内容签名而不是数组引用做依赖）；
 * - refresh 由用户显式触发（例如刷新营销状态之后）。
 */
export function useMarketingStatus(ids: string[]): {
  statuses: MarketingStatusMap;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [statuses, setStatuses] = useState<MarketingStatusMap>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const idsRef = useRef<string[]>([]);

  // 列表每次渲染都会新建 ids 数组，因此依赖用去重排序后的内容签名，否则去抖永不触发
  const idKey = [...new Set(ids)].sort().join('\n');

  const load = useCallback(async (list: string[]) => {
    const mine = ++seq.current;
    const unique = [...new Set(list)].filter((v) => typeof v === 'string' && v.length > 0).slice(0, MAX_IDS);
    if (unique.length === 0) {
      setStatuses({});
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const merged: MarketingStatusMap = {};
    try {
      for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
        const res = await fetch('/api/integrations/klaviyo/profiles/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: unique.slice(i, i + CHUNK_SIZE) }),
        });
        if (!res.ok) throw new Error(await readApiError(res));
        const data = (await res.json()) as StatusResponse;
        Object.assign(merged, data.statuses ?? {});
      }
      if (mine !== seq.current) return;
      setStatuses(merged);
    } catch (e) {
      if (mine !== seq.current) return;
      // 读取失败时保留上一次的缓存结果，只提示错误，不把整列伪装成「未查询」
      setError(errorText(e, '营销状态读取失败'));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    idsRef.current = ids;
    const timer = window.setTimeout(() => void load(ids), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [idKey, load]);

  const refresh = useCallback(() => {
    void load(idsRef.current);
  }, [load]);

  return { statuses, loading, error, refresh };
}