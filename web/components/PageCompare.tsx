'use client';

import { int, money, pct } from '@/lib/format';
import { LineChart } from '@/components/LineChart';
import type { DayPoint, LandingRow } from '@/lib/trafficMock';
import type { Range } from '@/lib/dateRange';

const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);

function agg(rows: DayPoint[]) {
  const sessions = sum(rows.map((r) => r.sessions));
  const orders = sum(rows.map((r) => r.orders));
  const revenue = sum(rows.map((r) => r.revenue));
  return { sessions, orders, revenue, cvr: sessions ? orders / sessions : 0, aov: orders ? revenue / orders : 0, perDay: rows.length ? sessions / rows.length : 0 };
}

function Change({ cur, prev }: { cur: number; prev: number }) {
  if (!prev) return <span className="muted">-</span>;
  const d = cur / prev - 1;
  return <span className={d < 0 ? 'neg' : 'pos'}>{(d >= 0 ? '▲ ' : '▼ ') + Math.abs(d * 100).toFixed(1) + '%'}</span>;
}

/** 右侧弹窗：选中页面在所选时间内的访问数据 vs 上期 */
export function PageCompare({ page, cur, prev, range, prevRange, onClose }: { page: LandingRow; cur: DayPoint[]; prev: DayPoint[]; range: Range; prevRange: Range; onClose: () => void }) {
  const c = agg(cur);
  const p = agg(prev);
  const hasPrev = prev.length > 0;
  const pad = (rows: DayPoint[], f: (r: DayPoint) => number) => cur.map((_, i) => (rows[i] ? f(rows[i]) : 0));

  const rows: { label: string; cur: string; prev: string; c: number; p: number }[] = [
    { label: '会话数', cur: int(c.sessions), prev: int(p.sessions), c: c.sessions, p: p.sessions },
    { label: '日均会话', cur: int(Math.round(c.perDay)), prev: int(Math.round(p.perDay)), c: c.perDay, p: p.perDay },
    { label: '订单数', cur: int(c.orders), prev: int(p.orders), c: c.orders, p: p.orders },
    { label: '转化率', cur: pct(c.cvr), prev: pct(p.cvr), c: c.cvr, p: p.cvr },
    { label: '客单价', cur: money(c.aov), prev: money(p.aov), c: c.aov, p: p.aov },
    { label: '销售额', cur: money(c.revenue), prev: money(p.revenue), c: c.revenue, p: p.revenue },
  ];

  return (
    <aside className="detail">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ wordBreak: 'break-all' }}>{page.path}</span>
        <button style={{ marginLeft: 'auto' }} onClick={onClose}>关闭</button>
      </h3>
      <div className="muted" style={{ fontSize: 12, lineHeight: 1.7, marginBottom: 8 }}>
        <div>本期：{range.from} ~ {range.to}（{cur.length} 天）</div>
        <div>上期：{prevRange.from} ~ {prevRange.to}（{prev.length} 天）</div>
      </div>

      {!hasPrev && <div className="neg" style={{ fontSize: 12, marginBottom: 8 }}>上期区间超出可用数据，无法对比。</div>}

      <h4>访问数据对比</h4>
      <table className="plain">
        <thead><tr><th>指标</th><th className="n">本期</th><th className="n">上期</th><th className="n">变化</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              <td className="n">{r.cur}</td>
              <td className="n">{hasPrev ? r.prev : '-'}</td>
              <td className="n">{hasPrev ? <Change cur={r.c} prev={r.p} /> : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4 style={{ marginTop: 14 }}>每日会话（本期 vs 上期，按第 N 天对齐）</h4>
      <LineChart
        labels={cur.map((r) => r.date)}
        series={[
          { name: '本期', color: '#3b82f6', values: cur.map((r) => r.sessions) },
          { name: '上期', color: '#94a3b8', dashed: true, values: pad(prev, (r) => r.sessions) },
        ]}
        height={170}
      />

      <h4 style={{ marginTop: 14 }}>每日转化率（本期 vs 上期）</h4>
      <LineChart
        labels={cur.map((r) => r.date)}
        series={[
          { name: '本期', color: '#16a34a', values: cur.map((r) => (r.sessions ? r.orders / r.sessions : 0)) },
          { name: '上期', color: '#94a3b8', dashed: true, values: pad(prev, (r) => (r.sessions ? r.orders / r.sessions : 0)) },
        ]}
        height={170}
        fmt={(v) => (v * 100).toFixed(1) + '%'}
      />

      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        页面现状指标（不随时间变化的 mock 值）：跳出 {pct(page.bounce)} · 首屏流失 {pct(page.firstScreenLoss)} · 加购 {pct(page.addToCartRate)} · LCP {page.lcp.toFixed(1)}s。接入 GA4 后这些指标也可以按本期/上期分别对比。
      </div>
    </aside>
  );
}
