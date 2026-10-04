'use client';

import { useEffect, useMemo, useState } from 'react';
import { DataTable, downloadCsv, filterRows, sortRows, toCsv, type Column, type Sort } from '@/components/DataTable';
import { MiniTable, Sparkline } from '@/components/Sparkline';
import { ProductInsights, enrich, type QuadrantKey } from '@/components/ProductInsights';
import { int, money, pct } from '@/lib/format';
import { useHotReload } from '@/lib/useHotReload';
import { DataRefreshButton } from '@/components/DataRefreshButton';
import type { ProductDetail, ProductRow } from '@/lib/mock';

const COLUMNS: Column<ProductRow>[] = [
  { key: 'title', label: '产品', cell: (r) => r.title },
  { key: 'category', label: '类目', cell: (r) => r.category },
  { key: 'units', label: '销量', numeric: true, cell: (r) => r.units, display: (r) => int(r.units) },
  { key: 'revenue', label: '净收入 (USD)', numeric: true, cell: (r) => r.revenue, display: (r) => money(r.revenue) },
  { key: 'refundRate', label: '退款率', numeric: true, cell: (r) => r.refundRate, display: (r) => pct(r.refundRate) },
  { key: 'profit', label: '毛利 (USD)', numeric: true, cell: (r) => r.profit, display: (r) => money(r.profit) },
  { key: 'margin', label: '毛利率', numeric: true, cell: (r) => r.margin, display: (r) => pct(r.margin) },
  { key: 'buyers', label: '买家数', numeric: true, cell: (r) => r.buyers },
  { key: 'repeatBuyers', label: '复购买家', numeric: true, cell: (r) => r.repeatBuyers },
  {
    key: 'trend30',
    label: '环比',
    numeric: true,
    cell: (r) => r.trend30,
    display: (r) => pct(r.trend30),
    tone: (r) => (r.trend30 == null ? undefined : r.trend30 < 0 ? 'neg' : 'pos'),
  },
];

const PRESETS = [
  { label: '近7天', days: 7 },
  { label: '近30天', days: 30 },
  { label: '近90天', days: 90 },
];

export function ProductsView() {
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState<Sort>({ key: 'revenue', dir: -1 });
  const [selected, setSelected] = useState<string | null>(null);
  const [quadrant, setQuadrant] = useState<QuadrantKey | null>(null);
  const [detail, setDetail] = useState<ProductDetail | null>(null);
  const { version } = useHotReload();
  const [tick, setTick] = useState(0);

  const qs = from || to ? `?from=${from}&to=${to}` : '';

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch('/api/products' + qs)
      .then((r) => r.json())
      .then((d: ProductRow[]) => {
        if (alive) {
          setRows(d);
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [qs, version, tick]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let alive = true;
    fetch(`/api/products/${selected}${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive) setDetail(d);
      });
    return () => {
      alive = false;
    };
  }, [selected, qs, version, tick]);

  const quadOf = useMemo(() => new Map(enrich(rows).map((e) => [e.id, e.quadrant] as const)), [rows]);
  const visible = useMemo(() => {
    const base = quadrant ? rows.filter((r) => quadOf.get(r.id) === quadrant) : rows;
    return sortRows(filterRows(base, COLUMNS, query), COLUMNS, sort);
  }, [rows, query, sort, quadrant, quadOf]);

  const setPreset = (days: number) => {
    if (!days) {
      setFrom('');
      setTo('');
      return;
    }
    const end = new Date();
    const start = new Date(Date.now() - (days - 1) * 86_400_000);
    setFrom(start.toISOString().slice(0, 10));
    setTo(end.toISOString().slice(0, 10));
  };

  return (
    <>
      <div className="content">
        <div className="bar">
          <input type="text" placeholder="筛选关键字..." value={query} onChange={(e) => setQuery(e.target.value)} />
          <span className="ranges">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="开始日期" />
            -
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="结束日期" />
            {PRESETS.map((p) => (
              <button key={p.days} onClick={() => setPreset(p.days)}>
                {p.label}
              </button>
            ))}
            <button onClick={() => setPreset(0)}>全部</button>
          </span>
          <button onClick={() => downloadCsv('products.csv', toCsv(COLUMNS, visible))}>导出 CSV</button>
          <DataRefreshButton onDone={() => setTick((t) => t + 1)} />
          <span className="muted">{loading ? '加载中...' : `${visible.length} 行`}</span>
        </div>
        <ProductInsights
          rows={rows}
          activeId={selected}
          onPick={(id) => setSelected(id === selected ? null : id)}
          quadrant={quadrant}
          onQuadrant={setQuadrant}
        />
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
          <h3>{detail.title}</h3>
          <div className="muted">
            {detail.category} · 销量 {int(detail.units)} · 净收入 {money(detail.revenue)} · 毛利率 {pct(detail.margin)}
          </div>
          <h4>近 26 周净收入</h4>
          <Sparkline values={detail.weekly} />
          <h4>主要买家</h4>
          <MiniTable
            rows={detail.buyersList}
            columns={[
              { label: '邮箱', value: (b) => b.email },
              { label: '国家', value: (b) => b.country },
              { label: '订单', numeric: true, value: (b) => b.orders },
              { label: '件数', numeric: true, value: (b) => b.units },
              { label: '金额 (USD)', numeric: true, value: (b) => money(b.amount) },
            ]}
          />
          <h4>常一起购买</h4>
          <MiniTable
            rows={detail.coProducts}
            columns={[
              { label: '产品', value: (c) => c.product },
              { label: '客户数', numeric: true, value: (c) => c.count },
              { label: 'Lift', numeric: true, value: (c) => c.lift },
            ]}
          />
        </aside>
      )}
    </>
  );
}