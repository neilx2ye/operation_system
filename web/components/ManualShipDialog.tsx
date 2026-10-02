'use client';

import { useState } from 'react';
import type { OrderDetail } from '@/lib/mock';
import { orderWeight, unitKg, validateManual, type ManualOrder, type ManualParcel } from '@/lib/shipTypes';

type Props = {
  detail: OrderDetail;
  defaults: { channelCode: string; unitWeightKg: number };
  shopifyReady: boolean;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (m: ManualOrder) => void;
};

function initial(d: OrderDetail, def: Props['defaults'], shopifyReady: boolean): ManualOrder {
  const s = d.shipping;
  return {
    channelCode: def.channelCode,
    currency: 'USD',
    receiver: { name: s.name, phone: s.phone, line1: s.line1, line2: s.line2, city: s.city, state: s.state, zip: s.zip, country: s.country },
    parcels: d.lines
      .filter((l) => !l.refunded)
      .map((l) => ({ englishName: l.product, chineseName: '', qty: l.qty, unitPrice: l.price, unitWeightKg: unitKg(l.weightG, def.unitWeightKg), sku: l.sku })),
    syncShopify: shopifyReady,
    notifyCustomer: false,
  };
}

export function ManualShipDialog({ detail, defaults, shopifyReady, busy, onCancel, onSubmit }: Props) {
  const [m, setM] = useState<ManualOrder>(() => initial(detail, defaults, shopifyReady));
  const [err, setErr] = useState('');

  const setR = (k: keyof ManualOrder['receiver']) => (e: React.ChangeEvent<HTMLInputElement>) => setM({ ...m, receiver: { ...m.receiver, [k]: e.target.value } });
  const setP = (i: number, patch: Partial<ManualParcel>) => setM({ ...m, parcels: m.parcels.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const totalW = m.parcels.reduce((s, p) => s + p.qty * p.unitWeightKg, 0);
  const missing = orderWeight(detail.lines, defaults.unitWeightKg).missing;
  const totalV = m.parcels.reduce((s, p) => s + p.qty * p.unitPrice, 0);

  function submit() {
    const bad = validateManual(m);
    if (bad) return setErr(bad);
    setErr('');
    onSubmit(m);
  }

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>手动建单 · {detail.id}</b>
          <span className="muted">已用订单信息预填,可逐项修改后再提交到云途</span>
          <span className="spacer" />
          <button className="tag-x" onClick={onCancel} aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="modal-body">
          <h4>发货渠道</h4>
          <div className="mgrid">
            <label>
              渠道代码 *
              <input type="text" value={m.channelCode} onChange={(e) => setM({ ...m, channelCode: e.target.value })} />
            </label>
            <label>
              申报币种
              <input type="text" value={m.currency} onChange={(e) => setM({ ...m, currency: e.target.value.toUpperCase() })} />
            </label>
          </div>

          <h4>收件信息</h4>
          <div className="mgrid">
            <label>
              姓名 *
              <input type="text" value={m.receiver.name} onChange={setR('name')} />
            </label>
            <label>
              电话 *
              <input type="text" value={m.receiver.phone} onChange={setR('phone')} />
            </label>
            <label className="span2">
              地址 1 *
              <input type="text" value={m.receiver.line1} onChange={setR('line1')} />
            </label>
            <label className="span2">
              地址 2
              <input type="text" value={m.receiver.line2} onChange={setR('line2')} />
            </label>
            <label>
              城市 *
              <input type="text" value={m.receiver.city} onChange={setR('city')} />
            </label>
            <label>
              州/省
              <input type="text" value={m.receiver.state} onChange={setR('state')} />
            </label>
            <label>
              邮编
              <input type="text" value={m.receiver.zip} onChange={setR('zip')} />
            </label>
            <label>
              国家代码 *
              <input type="text" maxLength={2} value={m.receiver.country} onChange={(e) => setM({ ...m, receiver: { ...m.receiver, country: e.target.value.toUpperCase() } })} />
            </label>
          </div>

          <h4>申报商品</h4>
          <table className="plain mtable">
            <thead>
              <tr>
                <th>英文品名 *</th>
                <th>中文品名</th>
                <th className="n">数量</th>
                <th className="n">申报单价</th>
                <th className="n">单件重(kg)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {m.parcels.map((p, i) => (
                <tr key={i}>
                  <td>
                    <input type="text" className="w-name" value={p.englishName} onChange={(e) => setP(i, { englishName: e.target.value })} />
                  </td>
                  <td>
                    <input type="text" className="w-name" value={p.chineseName} onChange={(e) => setP(i, { chineseName: e.target.value })} />
                  </td>
                  <td className="n">
                    <input type="number" min={1} step={1} className="w-num" value={p.qty} onChange={(e) => setP(i, { qty: Number(e.target.value) })} />
                  </td>
                  <td className="n">
                    <input type="number" min={0} step="0.01" className="w-num" value={p.unitPrice} onChange={(e) => setP(i, { unitPrice: Number(e.target.value) })} />
                  </td>
                  <td className="n">
                    <input type="number" min={0} step="0.01" className="w-num" value={p.unitWeightKg} onChange={(e) => setP(i, { unitWeightKg: Number(e.target.value) })} />
                  </td>
                  <td>
                    <button className="tag-x" title="删除该行" onClick={() => setM({ ...m, parcels: m.parcels.filter((_, j) => j !== i) })}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {missing.length > 0 && <div className="notice err">{missing.join('、')} 尚未在「产品管理」填重量,已暂用默认值 {defaults.unitWeightKg} kg,请确认。</div>}
          <div className="muted msum">
            包裹总重 {totalW.toFixed(2)} kg · 申报总值 {totalV.toFixed(2)} {m.currency}
          </div>

          <h4>回写选项</h4>
          <label className="mcheck">
            <input type="checkbox" checked={m.syncShopify} disabled={!shopifyReady} onChange={(e) => setM({ ...m, syncShopify: e.target.checked })} />
            建单成功后把追踪号回写 Shopify{!shopifyReady && '(未配置 Shopify)'}
          </label>
          <label className="mcheck">
            <input type="checkbox" checked={m.notifyCustomer} disabled={!m.syncShopify} onChange={(e) => setM({ ...m, notifyCustomer: e.target.checked })} />
            回写时邮件通知客户
          </label>
        </div>

        <div className="modal-foot">
          {err && <span className="neg">{err}</span>}
          <span className="spacer" />
          <button onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button className="primary" onClick={submit} disabled={busy}>
            {busy ? '提交中...' : '提交到云途'}
          </button>
        </div>
      </div>
    </div>
  );
}
