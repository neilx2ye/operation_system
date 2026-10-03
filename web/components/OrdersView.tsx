'use client';

import { useEffect, useMemo, useState } from 'react';
import { DataTable, downloadCsv, filterRows, sortRows, toCsv, type Column, type Sort } from '@/components/DataTable';
import { MiniTable } from '@/components/Sparkline';
import { ShipCard } from '@/components/ShipCard';
import { int, money } from '@/lib/format';
import { useHotReload } from '@/lib/useHotReload';
import type { OrderDetail, OrderItemPreview, OrderRow } from '@/lib/mock';

function ItemThumb({ imageUrl, name }: { imageUrl: string; name: string }) {
  return (
    <span className="order-item-thumb">
      {imageUrl ? <img src={imageUrl} alt={name} loading="lazy" /> : <span>无图</span>}
    </span>
  );
}

function OrderItemsCell({ items }: { items: OrderItemPreview[] }) {
  return (
    <div className="order-items">
      {items.map((item, i) => (
        <div className="order-item" key={item.product + ':' + i}>
          <ItemThumb imageUrl={item.imageUrl} name={item.product} />
          <div className="order-item-copy">
            <div className="order-item-name">{item.product}</div>
            <div className="muted">× {item.qty}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function logisticsTone(status: string): string {
  if (/送达|运输中|派送中|揽收|已发货|已同步/.test(status)) return 'green';
  if (/异常|失败|延误|未送达|取消|被拒|作废/.test(status)) return 'red';
  if (/未发货|处理中|等待|排期|已创建|未回写|演示|暂停|部分/.test(status)) return 'amber';
  return '';
}

const COLUMNS: Column<OrderRow>[] = [
  { key: 'id', label: '订单号', cell: (r) => r.id },
  { key: 'date', label: '下单日期', cell: (r) => r.date },
  { key: 'email', label: '客户邮箱', cell: (r) => r.email },
  { key: 'country', label: '国家', cell: (r) => r.country },
  { key: 'source', label: '渠道', cell: (r) => r.source },
  {
    key: 'orderItems',
    label: 'Item',
    cell: (r) => r.orderItems.map((x) => x.product + ' x' + x.qty).join(', '),
    display: (r) => <OrderItemsCell items={r.orderItems} />,
  },
  { key: 'items', label: '件数', numeric: true, cell: (r) => r.items },
  { key: 'gross', label: '订单金额', numeric: true, cell: (r) => r.gross, display: (r) => money(r.gross) },
  { key: 'refunded', label: '退款金额', numeric: true, cell: (r) => r.refunded, display: (r) => money(r.refunded), tone: (r) => (r.refunded > 0 ? 'neg' : undefined) },
  { key: 'net', label: '净额', numeric: true, cell: (r) => r.net, display: (r) => money(r.net) },
  {
    key: 'logisticsStatus',
    label: '物流状态',
    cell: (r) => r.logisticsStatus,
    display: (r) => <span className={'tag ' + logisticsTone(r.logisticsStatus)}>{r.logisticsStatus}</span>,
  },
];

const STATUS_ORDER = [
  '未发货',
  '已创建运单',
  '已建单未回写',
  '已同步追踪号',
  '已确认发货',
  '已发货',
  '承运商已揽收',
  '运输中',
  '派送中',
  '已送达',
  '物流延误',
  '物流异常',
  '无需发货',
  '演示单',
];

export function OrdersView() {
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [logisticsStatus, setLogisticsStatus] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>({ key: 'date', dir: -1 });
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const { version } = useHotReload();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch('/api/orders')
      .then((r) => r.json())
      .then((d: OrderRow[]) => {
        if (alive) {
          setRows(d);
          setLoading(false);
        }
      })
      .catch(() => {
        if (alive) setLoading(false);
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

  const logisticsOptions = useMemo(() => {
    const set = new Set(rows.map((r) => r.logisticsStatus).filter(Boolean));
    return [...set].sort((a, b) => {
      const ai = STATUS_ORDER.indexOf(a);
      const bi = STATUS_ORDER.indexOf(b);
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a.localeCompare(b, 'zh-CN');
    });
  }, [rows]);

  const visible = useMemo(() => {
    const base = logisticsStatus ? rows.filter((r) => r.logisticsStatus === logisticsStatus) : rows;
    return sortRows(filterRows(base, COLUMNS, query), COLUMNS, sort);
  }, [rows, query, logisticsStatus, sort]);

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
            <b>物流状态筛选</b>
            <span className={'tag clickable' + (logisticsStatus === null ? ' on' : '')} onClick={() => setLogisticsStatus(null)}>
              全部 {rows.length}
            </span>
            {logisticsOptions.map((s) => (
              <span
                key={s}
                className={'tag clickable' + (logisticsStatus === s ? ' on' : '')}
                onClick={() => setLogisticsStatus(logisticsStatus === s ? null : s)}
              >
                {s} {rows.filter((r) => r.logisticsStatus === s).length}
              </span>
            ))}
          </div>
          <div className="muted">
            当前列表：{int(totals.count)} 单 · 订单金额 {money(totals.gross)} · 退款 {money(totals.refunded)} · 净额 {money(totals.net)}
          </div>
        </div>

        <div className="bar">
          <input type="text" placeholder="筛选订单号 / Item / 邮箱 / 国家 / 渠道 / 物流状态..." value={query} onChange={(e) => setQuery(e.target.value)} />
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
            {detail.date} · 订单状态 {detail.status} · 物流 {detail.logisticsStatus} · {detail.email} · {detail.country} · {detail.source}
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
              {
                label: 'Item',
                value: (l) => (
                  <div className="detail-item">
                    <ItemThumb imageUrl={l.imageUrl} name={l.product} />
                    <span>{l.product}</span>
                  </div>
                ),
              },
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
