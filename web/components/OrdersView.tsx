'use client';

import { useEffect, useMemo, useState } from 'react';
import { DataTable, downloadCsv, filterRows, sortRows, toCsv, type Column, type Sort } from '@/components/DataTable';
import { MiniTable } from '@/components/Sparkline';
import { ShipCard } from '@/components/ShipCard';
import { int, money } from '@/lib/format';
import { useHotReload } from '@/lib/useHotReload';
import type { OrderDetail, OrderRow } from '@/lib/mock';

const STATUSES = ['已完成', '部分退款', '已退款'] as const;

const COLUMNS: Column<OrderRow>[] = [
  { key: 'id', label: '订单号', cell: (r) => r.id },
  { key: 'date', label: '下单日期', cell: (r) => r.date },
  { key: 'email', label: '客户邮箱', cell: (r) => r.email },
  { key: 'country', label: '国家', cell: (r) => r.country },
  { key: 'source', label: '渠道', cell: (r) => r.source },
  { key: 'skus', label: 'SKU', cell: (r) => r.skus },
  { key: 'items', label: '件数', numeric: true, cell: (r) => r.items },
  { key: 'gross', label: '订单金额', numeric: true, cell: (r) => r.gross, display: (r) => money(r.gross) },
  { key: 'refunded', label: '退款金额', numeric: true, cell: (r) => r.refunded, display: (r) => money(r.refunded), tone: (r) => (r.refunded > 0 ? 'neg' : undefined) },
  { key: 'net', label: '净额', numeric: true, cell: (r) => r.net, display: (r) => money(r.net) },
  { key: 'status', label: '状态', cell: (r) => r.status },
];

export function OrdersView() {
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>({ key: 'date', dir: -1 });
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const { version } = useHotReload();
  useEffect(() => {
    let alive = true;
    fetch('/api/orders')
      .then((r) => r.json())
      .then((d: OrderRow[]) => {
        if (alive) {
          setRows(d);
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [version]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let alive = true;
    fetch('/api/orders?id=' + encodeURIComponent(selected))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive) setDetail(d);
      });
    return () => {
      alive = false;
    };
  }, [selected, version]);

  const visible = useMemo(() => {
    const base = status ? rows.filter((r) => r.status === status) : rows;
    return sortRows(filterRows(base, COLUMNS, query), COLUMNS, sort);
  }, [rows, query, status, sort]);

  const totals = useMemo(
    () => ({
      count: visible.length,
      gross: visible.reduce((s, r) => s + r.gross, 0),
      refunded: visible.reduce((s, r) => s + r.refunded, 0),
      net: visible.reduce((s, r) => s + r.net, 0),
    }),
    [visible],
  );

  return (
    <>
      <div className="content">
        <div className="panel">
          <div className="tag-list">
            <b>状态筛选</b>
            <span className={'tag clickable' + (status === null ? ' on' : '')} onClick={() => setStatus(null)}>
              全部 {rows.length}
            </span>
            {STATUSES.map((s) => (
              <span key={s} className={'tag clickable' + (status === s ? ' on' : '')} onClick={() => setStatus(status === s ? null : s)}>
                {s} {rows.filter((r) => r.status === s).length}
              </span>
            ))}
          </div>
          <div className="muted">
            当前列表：{int(totals.count)} 单 · 订单金额 {money(totals.gross)} · 退款 {money(totals.refunded)} · 净额 {money(totals.net)}
          </div>
        </div>

        <div className="bar">
          <input type="text" placeholder="筛选订单号 / SKU / 邮箱 / 国家 / 渠道 / 状态..." value={query} onChange={(e) => setQuery(e.target.value)} />
          <button onClick={() => downloadCsv('orders.csv', toCsv(COLUMNS, visible))}>导出 CSV</button>
          <span className="muted">{loading ? '加载中...' : `${visible.length} 行`}</span>
        </div>
        <DataTable
          columns={COLUMNS}
          rows={visible}
          sort={sort}
          onSortChange={setSort}
          rowKey={(r) => r.id}
          activeKey={selected}
          onRowClick={(r) => setSelected(r.id === selected ? null : r.id)}
        />
      </div>

      {detail && (
        <aside className="detail">
          <h3>订单 {detail.id}</h3>
          <div className="muted">
            {detail.date} · {detail.status} · {detail.email} · {detail.country} · {detail.source}
          </div>
          <div className="muted">
            订单金额 {money(detail.gross)} · 退款 {money(detail.refunded)} · 净额 {money(detail.net)} · 毛利 {money(detail.profit)}
          </div>
          <ShipCard detail={detail} />
          <h4>客户信息</h4>
          <MiniTable
            rows={[detail.customer]}
            columns={[
              { label: '姓名', value: (c) => c.name },
              { label: '邮箱', value: (c) => c.email },
              { label: '电话', value: (c) => c.phone },
              { label: '国家', value: (c) => c.country },
              { label: '渠道', value: (c) => c.source },
              { label: '累计订单', numeric: true, value: (c) => c.orders },
              { label: 'LTV', numeric: true, value: (c) => money(c.ltv) },
              { label: '首单', value: (c) => c.firstOrder ?? '-' },
            ]}
          />
          <h4>收货地址</h4>
          <div className="addr">
            <div>
              <b>{detail.shipping.name}</b> · {detail.shipping.phone}
            </div>
            <div>{detail.shipping.line1}</div>
            {detail.shipping.line2 && <div>{detail.shipping.line2}</div>}
            <div>
              {detail.shipping.city}, {detail.shipping.state} {detail.shipping.zip}
            </div>
            <div>{detail.shipping.country}</div>
            <button
              onClick={() => {
                const s = detail.shipping;
                const text = [s.name + ' ' + s.phone, s.line1, s.line2, s.city + ', ' + s.state + ' ' + s.zip, s.country].filter(Boolean).join('\n');
                navigator.clipboard?.writeText(text);
              }}
            >
              复制地址
            </button>
          </div>
          <h4>商品明细</h4>
          <MiniTable
            rows={detail.lines}
            columns={[
              { label: '产品', value: (l) => l.product },
              { label: 'SKU', value: (l) => l.sku },
              { label: '数量', numeric: true, value: (l) => l.qty },
              { label: '单价', numeric: true, value: (l) => money(l.price) },
              { label: '小计', numeric: true, value: (l) => money(l.amount) },
              { label: '退款', value: (l) => (l.refunded ? '已退款 ' + (l.refundDate ?? '') : '-') },
            ]}
          />
        </aside>
      )}
    </>
  );
}
