'use client';

import { useEffect, useRef, useState } from 'react';

// 各数据页面通用的「更新数据」按钮：触发一次增量同步（只拉取自上次以来的变更），
// 完成后回调 onDone 让当前页面重新取数。其它已打开的页面由服务端广播自动刷新。

type SyncStatus = {
  state: 'idle' | 'running' | 'done' | 'error';
  mode?: 'full' | 'incremental';
  step: string;
  error: string | null;
  counts: Record<string, number> | null;
  warnings: string[];
};

export function DataRefreshButton({ onDone, label = '更新数据' }: { onDone?: () => void; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function poll() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      let d: SyncStatus | null = null;
      try {
        const r = await fetch('/api/shopify/sync');
        if (r.ok) d = await r.json();
      } catch {
        /* 单次失败继续轮询 */
      }
      if (!alive.current) return;
      if (d && d.state === 'running') {
        setMsg({ ok: true, text: d.step || '同步中…' });
        poll();
        return;
      }
      setBusy(false);
      if (!d) return;
      if (d.state === 'done') {
        const c = d.counts || {};
        const inc = d.mode === 'incremental';
        setMsg({
          ok: true,
          text: inc
            ? `已更新 · 商品 ${c.changedProducts ?? 0} · 订单 ${c.changedOrders ?? 0} · 客户 ${c.changedCustomers ?? 0}`
            : `全量同步完成 · 商品 ${c.products ?? 0} · 订单 ${c.orders ?? 0} · 客户 ${c.customers ?? 0}`,
        });
        onDone?.();
      } else if (d.state === 'error') {
        setMsg({ ok: false, text: '更新失败：' + (d.error || '未知错误') });
      }
    }, 2000);
  }

  async function start() {
    if (busy) return;
    setBusy(true);
    setMsg({ ok: true, text: '正在更新…' });
    try {
      const r = await fetch('/api/shopify/sync?mode=incremental', { method: 'POST' });
      const d = await r.json().catch(() => null);
      // 409 = 已有一个同步在跑，继续轮询即可
      if (!r.ok && r.status !== 409) {
        setBusy(false);
        setMsg({ ok: false, text: d?.message || '无法开始更新(HTTP ' + r.status + ')' });
        return;
      }
      poll();
    } catch (e: any) {
      setBusy(false);
      setMsg({ ok: false, text: e.message || '网络错误' });
    }
  }

  return (
    <span className="data-refresh">
      <button type="button" onClick={start} disabled={busy}>
        {busy ? '更新中…' : label}
      </button>
      {msg && <span className="muted data-refresh-msg" style={msg.ok ? undefined : { color: '#ef4444' }}>{msg.text}</span>}
    </span>
  );
}
