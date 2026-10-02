'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { OrderDetail } from '@/lib/mock';
import { orderWeight, type ManualOrder } from '@/lib/shipTypes';
import { useHotReload } from '@/lib/useHotReload';
import { ManualShipDialog } from '@/components/ManualShipDialog';

type Shipment = {
  orderId: string;
  waybillNumber: string;
  trackingNumber: string;
  yuntuAt: string;
  shopifyAt: string | null;
  shopifyError: string | null;
  dryRun: boolean;
  manual?: boolean;
  shopifySkipped?: boolean;
};
type Ready = { yuntu: boolean; shopify: boolean };

const fmt = (iso: string) => iso.slice(0, 16).replace('T', ' ');

function Step({ state, title, sub }: { state: 'done' | 'todo' | 'fail' | 'skip'; title: string; sub?: string }) {
  const icon = state === 'done' ? '✓' : state === 'fail' ? '!' : state === 'skip' ? '-' : '';
  return (
    <div className={'ship-step ' + state}>
      <span className="ship-dot">{icon}</span>
      <div>
        <div className="ship-step-title">{title}</div>
        {sub && <div className="ship-step-sub">{sub}</div>}
      </div>
    </div>
  );
}

export function ShipCard({ detail }: { detail: OrderDetail }) {
  const orderId = detail.id;
  const refunded = detail.status === '已退款';
  const [defaults, setDefaults] = useState({ channelCode: '', unitWeightKg: 0.3 });
  const [dialog, setDialog] = useState(false);
  const [shipment, setShipment] = useState<Shipment | null>(null);
  const [ready, setReady] = useState<Ready | null>(null);
  const [busy, setBusy] = useState(false);
  const [notify, setNotify] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const { version } = useHotReload();

  useEffect(() => {
    let alive = true;
    setMsg(null);
    setShipment(null);
    fetch('/api/orders/ship?id=' + encodeURIComponent(orderId))
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setShipment(d.shipment ?? null);
        setReady(d.ready ?? null);
        if (d.defaults) setDefaults(d.defaults);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [orderId, version]);

  async function run(retryShopifyOnly: boolean, manual?: ManualOrder) {
    if (!retryShopifyOnly && !manual && !confirm(`确认把订单 ${orderId} 创建到云途发货系统?${ready?.shopify ? (notify ? '\n将同步追踪号到 Shopify并邮件通知客户。' : '\n将同步追踪号到 Shopify(不通知客户)。') : ''}`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch('/api/orders/ship', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: orderId, notifyCustomer: notify, retryShopifyOnly, manual }),
      });
      const d = await r.json();
      if (r.ok) setDialog(false);
      if (d.shipment) setShipment(d.shipment);
      if (!r.ok) setMsg({ ok: false, text: d.error || '请求失败' });
      else if (d.shipment?.shopifyError) setMsg({ ok: false, text: '云途已建单,但 Shopify 回写失败' });
      else setMsg({ ok: true, text: d.dryRun ? '演示模式:未调用真实接口' : '已完成' });
    } catch (e: any) {
      setMsg({ ok: false, text: e.message || '网络错误' });
    } finally {
      setBusy(false);
    }
  }

  function copy(text: string) {
    navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  const badge = !shipment
    ? { cls: '', text: '未发货' }
    : shipment.dryRun
      ? { cls: 'amber', text: '演示单' }
      : shipment.shopifyAt
        ? { cls: 'green', text: '已同步' }
        : { cls: shipment.shopifySkipped ? 'amber' : 'red', text: shipment.shopifySkipped ? '未回写' : '待回写' };

  const missing = ready && !ready.yuntu;
  const w = orderWeight(detail.lines, defaults.unitWeightKg);

  return (
    <section className="ship">
      <div className="ship-head">
        <b>云途发货</b>
        <span className={'tag ' + badge.cls}>{badge.text}</span>
        {shipment?.manual && <span className="tag">手动</span>}
        <span className="spacer" />
        <Link href="/settings" className="ship-cfg">接口设置</Link>
      </div>

      {missing && (
        <div className="notice err">
          尚未配置云途接口,点击会生成演示单(不调用真实接口)。<Link href="/settings">去设置</Link>
        </div>
      )}

      <div className="ship-steps">
        <Step state={shipment ? 'done' : 'todo'} title="云途建单" sub={shipment ? fmt(shipment.yuntuAt) : '按收货地址与商品生成运单'} />
        <Step
          state={!shipment ? 'todo' : shipment.dryRun || shipment.shopifySkipped ? 'skip' : shipment.shopifyAt ? 'done' : shipment.shopifyError ? 'fail' : 'todo'}
          title="回写 Shopify"
          sub={!shipment ? '把追踪号写入 fulfillment' : shipment.dryRun ? '演示模式不回写' : shipment.shopifySkipped ? '建单时选择不回写' : shipment.shopifyAt ? fmt(shipment.shopifyAt) : shipment.shopifyError || '等待同步'}
        />
      </div>

      {shipment && (
        <div className="ship-nums">
          <div>
            <div className="ship-k">追踪号</div>
            <div className="ship-v">{shipment.trackingNumber}</div>
          </div>
          <div>
            <div className="ship-k">云途运单号</div>
            <div className="ship-v">{shipment.waybillNumber}</div>
          </div>
          <div className="ship-actions">
            <button onClick={() => copy(shipment.trackingNumber)}>{copied ? '已复制' : '复制'}</button>
            {!shipment.dryRun && (
              <a className="btn" href={'https://www.yuntrack.com/parcelTracking?id=' + encodeURIComponent(shipment.trackingNumber)} target="_blank" rel="noreferrer">
                查轨迹
              </a>
            )}
          </div>
        </div>
      )}

      {!shipment && (
        <div className="ship-weight">
          <span>
            预计包裹重量 <b>{w.totalKg} kg</b>
          </span>
          {w.missing.length > 0 && (
            <span className="neg">
              {w.missing.length} 个 SKU 未填重量,按默认 {defaults.unitWeightKg} kg/件估算 <Link href="/manage">去填写</Link>
            </span>
          )}
        </div>
      )}

      {!shipment && (
        <div className="ship-act">
          <label className="ship-notify">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            回写后邮件通知客户
          </label>
          <div className="ship-btns">
            <button disabled={busy || refunded} onClick={() => setDialog(true)}>
              手动建单
            </button>
            <button className="primary" disabled={busy || refunded} onClick={() => run(false)}>
              {busy ? '处理中...' : refunded ? '已全额退款' : '一键建单'}
            </button>
          </div>
        </div>
      )}

      {shipment && !shipment.dryRun && !shipment.shopifyAt && (
        <div className="ship-act">
          <button className="primary" disabled={busy} onClick={() => run(true)}>
            {busy ? '处理中...' : shipment?.shopifySkipped ? '同步到 Shopify' : '重试回写 Shopify'}
          </button>
        </div>
      )}

      {msg && <div className={'notice ' + (msg.ok ? 'ok' : 'err')}>{msg.text}</div>}

      {dialog && (
        <ManualShipDialog
          detail={detail}
          defaults={defaults}
          shopifyReady={!!ready?.shopify}
          busy={busy}
          onCancel={() => setDialog(false)}
          onSubmit={(m) => run(false, m)}
        />
      )}
    </section>
  );
}
