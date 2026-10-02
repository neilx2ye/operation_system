'use client';

import { useMemo, useState } from 'react';
import { int, money, pct } from '@/lib/format';
import type { ProductRow } from '@/lib/mock';

export const QUADRANTS = [
  { key: '明星款', color: '#16a34a', action: '高销量+高毛利：加预算、保库存、做主推与捆绑' },
  { key: '引流款', color: '#3b82f6', action: '高销量+低毛利：控成本/小幅提价，搭配高毛利款做套装' },
  { key: '潜力款', color: '#f59e0b', action: '低销量+高毛利：优化主图/详情页，增加曝光与广告测试' },
  { key: '淘汰候选', color: '#94a3b8', action: '低销量+低毛利：清仓、停投或下架，释放资金与预算' },
] as const;

export type QuadrantKey = (typeof QUADRANTS)[number]['key'];

export type Enriched = ProductRow & {
  abc: 'A' | 'B' | 'C';
  share: number;
  cumShare: number;
  quadrant: QuadrantKey;
  flags: string[];
};

const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 阈值集中在此，可按业务调整 */
export const quadrantCuts = (rows: ProductRow[]) => ({
  mu: median(rows.map((r) => r.units)),
  mm: median(rows.map((r) => r.margin)),
});

export const THRESH = { refund: 0.1, lowMargin: 0.3, decline: -0.3, surge: 0.3, abcA: 0.8, abcB: 0.95 };

export function enrich(rows: ProductRow[]): Enriched[] {
  const sorted = [...rows].sort((a, b) => b.revenue - a.revenue);
  const total = sorted.reduce((s, r) => s + Math.max(r.revenue, 0), 0);
  const mu = median(rows.map((r) => r.units));
  const mm = median(rows.map((r) => r.margin));
  let cum = 0;
  return sorted.map((r) => {
    const share = total > 0 ? Math.max(r.revenue, 0) / total : 0;
    const before = cum;
    cum += share;
    const abc = before < THRESH.abcA ? 'A' : before < THRESH.abcB ? 'B' : 'C';
    const hiU = r.units >= mu;
    const hiM = r.margin >= mm;
    const quadrant: QuadrantKey = hiU && hiM ? '明星款' : hiU ? '引流款' : hiM ? '潜力款' : '淘汰候选';
    const flags: string[] = [];
    if (r.refundRate >= THRESH.refund) flags.push('退款偏高');
    if (r.margin < THRESH.lowMargin) flags.push('毛利偏低');
    if (r.trend30 != null && r.trend30 <= THRESH.decline) flags.push('环比下滑');
    if (r.trend30 != null && r.trend30 >= THRESH.surge) flags.push('环比上升');
    if (r.buyers > 0 && r.repeatBuyers / r.buyers >= 0.2) flags.push('复购强');
    return { ...r, abc, share, cumShare: cum, quadrant, flags };
  });
}

function BarCell({ value, max, text }: { value: number; max: number; text: string }) {
  const w = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="bar-cell">
      <div className="bar-fill" style={{ width: w + '%' }} />
      <span>{text}</span>
    </div>
  );
}

const colorOf = (q: QuadrantKey) => QUADRANTS.find((x) => x.key === q)!.color;

function Scatter({ data, onPick, activeId, big, quadrant }: { data: Enriched[]; onPick: (id: string) => void; activeId: string | null; big: boolean; quadrant: QuadrantKey | null }) {
  const W = big ? 1000 : 560;
  const H = big ? 560 : 320;
  const P = big ? { l: 60, r: 20, t: 20, b: 50 } : { l: 46, r: 14, t: 14, b: 38 };
  const f1 = big ? 14 : 11;
  const f2 = big ? 12 : 10;
  const lim = big ? 24 : 14;
  const maxU = Math.max(...data.map((d) => d.units), 1) * 1.1;
  const ms = data.map((d) => d.margin);
  const minM = Math.min(...ms, 0);
  const maxM = Math.max(...ms, 0.1) * 1.1;
  const maxR = Math.max(...data.map((d) => d.revenue), 1);
  const x = (v: number) => P.l + (v / maxU) * (W - P.l - P.r);
  const y = (v: number) => H - P.b - ((v - minM) / (maxM - minM || 1)) * (H - P.t - P.b);
  const mu = median(data.map((d) => d.units));
  const mm = median(ms);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: big ? '100%' : W, height: 'auto' }}>
      <rect x={P.l} y={P.t} width={W - P.l - P.r} height={H - P.t - P.b} fill="#fafafa" stroke="#e5e7eb" />
      <line x1={x(mu)} x2={x(mu)} y1={P.t} y2={H - P.b} stroke="#cbd5e1" strokeDasharray="4 3" />
      <line x1={P.l} x2={W - P.r} y1={y(mm)} y2={y(mm)} stroke="#cbd5e1" strokeDasharray="4 3" />
      <text x={W - P.r - 4} y={P.t + 12} textAnchor="end" fontSize={f1} fill="#16a34a">明星款</text>
      <text x={W - P.r - 4} y={H - P.b - 6} textAnchor="end" fontSize={f1} fill="#3b82f6">引流款</text>
      <text x={P.l + 4} y={P.t + 12} fontSize={f1} fill="#f59e0b">潜力款</text>
      <text x={P.l + 4} y={H - P.b - 6} fontSize={f1} fill="#94a3b8">淘汰候选</text>
      <text x={(W + P.l) / 2} y={H - 8} textAnchor="middle" fontSize={f1} fill="#64748b">销量（件）→</text>
      <text x={12} y={H / 2} fontSize={f1} fill="#64748b" transform={`rotate(-90 12 ${H / 2})`} textAnchor="middle">毛利率 →</text>
      <text x={P.l - 4} y={y(maxM / 1.1) + 4} textAnchor="end" fontSize={f2} fill="#94a3b8">{pct(maxM / 1.1)}</text>
      <text x={P.l - 4} y={y(minM) + 4} textAnchor="end" fontSize={f2} fill="#94a3b8">{pct(minM)}</text>
      {data
        .filter((d) => !quadrant || d.quadrant === quadrant)
        .map((d) => {
        const r = (big ? 8 : 5) + Math.sqrt(Math.max(d.revenue, 0) / maxR) * (big ? 24 : 14);
        return (
          <g key={d.id} style={{ cursor: 'pointer' }} onClick={() => onPick(d.id)}>
            <circle
              cx={x(d.units)}
              cy={y(d.margin)}
              r={r}
              fill={colorOf(d.quadrant)}
              fillOpacity={0.55}
              stroke={activeId === d.id ? '#111827' : colorOf(d.quadrant)}
              strokeWidth={activeId === d.id ? 2 : 1}
            >
              <title>{`${d.title}\n销量 ${d.units} · 净收入 ${money(d.revenue)} · 毛利率 ${pct(d.margin)}`}</title>
            </circle>
            <text x={x(d.units)} y={y(d.margin) - r - 2} textAnchor="middle" fontSize={f2} fill="#475569">
              {d.title.length > lim ? d.title.slice(0, lim - 1) + '…' : d.title}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function ProductInsights({
  rows,
  activeId,
  onPick,
  quadrant,
  onQuadrant,
}: {
  rows: ProductRow[];
  activeId: string | null;
  onPick: (id: string) => void;
  quadrant: QuadrantKey | null;
  onQuadrant: (q: QuadrantKey | null) => void;
}) {
  const data = useMemo(() => enrich(rows), [rows]);
  const cuts = useMemo(() => quadrantCuts(rows), [rows]);
  const [zoom, setZoom] = useState(false);
  const shown = quadrant ? data.filter((d) => d.quadrant === quadrant) : data;
  const units = `销量`;
  const hi = (k: 'u' | 'm') => (k === 'u' ? `${units} ≥ ${cuts.mu}` : `毛利率 ≥ ${pct(cuts.mm)}`);
  const lo = (k: 'u' | 'm') => (k === 'u' ? `${units} < ${cuts.mu}` : `毛利率 < ${pct(cuts.mm)}`);
  const cond: Record<QuadrantKey, string> = {
    明星款: `${hi('u')} 且 ${hi('m')}`,
    引流款: `${hi('u')} 且 ${lo('m')}`,
    潜力款: `${lo('u')} 且 ${hi('m')}`,
    淘汰候选: `${lo('u')} 且 ${lo('m')}`,
  };
  const stat = useMemo(() => {
    const revenue = data.reduce((s, r) => s + r.revenue, 0);
    const profit = data.reduce((s, r) => s + r.profit, 0);
    const units = data.reduce((s, r) => s + r.units, 0);
    const refUnits = data.reduce((s, r) => s + r.refundRate * r.units, 0);
    const aCount = data.filter((d) => d.abc === 'A').length;
    const loss = data.filter((d) => d.profit <= 0).length;
    return { revenue, profit, units, refundRate: units ? refUnits / units : 0, aCount, loss };
  }, [data]);

  const cats = useMemo(() => {
    const m = new Map<string, Enriched[]>();
    data.forEach((d) => m.set(d.category, [...(m.get(d.category) || []), d]));
    return [...m.entries()]
      .map(([key, rs]) => {
        const revenue = rs.reduce((s, r) => s + r.revenue, 0);
        const profit = rs.reduce((s, r) => s + r.profit, 0);
        const units = rs.reduce((s, r) => s + r.units, 0);
        const ref = rs.reduce((s, r) => s + r.refundRate * r.units, 0);
        return { key, n: rs.length, revenue, profit, margin: revenue ? profit / revenue : 0, refundRate: units ? ref / units : 0 };
      })
      .sort((a, b) => b.revenue - a.revenue);
  }, [data]);

  const quad = useMemo(
    () =>
      QUADRANTS.map((q) => {
        const rs = data.filter((d) => d.quadrant === q.key);
        return { ...q, n: rs.length, revenue: rs.reduce((s, r) => s + r.revenue, 0), names: rs.map((r) => r.title) };
      }),
    [data],
  );

  const alerts = data.filter((d) => d.flags.some((f) => f === '退款偏高' || f === '环比下滑' || f === '毛利偏低'));
  const maxRev = Math.max(...data.map((d) => d.revenue), 0);

  if (!data.length) return null;

  return (
    <div className="insights">
      <div className="kpis">
        <div className="kpi"><div className="kpi-label">净收入 (USD)</div><div className="kpi-value">{money(stat.revenue)}</div></div>
        <div className="kpi"><div className="kpi-label">毛利 (USD)</div><div className="kpi-value">{money(stat.profit)}</div><div className="kpi-hint">毛利率 {pct(stat.revenue ? stat.profit / stat.revenue : 0)}</div></div>
        <div className="kpi"><div className="kpi-label">销量</div><div className="kpi-value">{int(stat.units)}</div></div>
        <div className="kpi"><div className="kpi-label">整体退款率</div><div className="kpi-value">{pct(stat.refundRate)}</div></div>
        <div className="kpi"><div className="kpi-label">A 类产品</div><div className="kpi-value">{stat.aCount} / {data.length}</div><div className="kpi-hint">贡献前 80% 净收入</div></div>
        <div className="kpi"><div className="kpi-label">毛利 ≤ 0 的产品</div><div className="kpi-value">{stat.loss}</div></div>
      </div>

      <div className="grid2">
        <div className="panel">
          <h4>利润矩阵（横轴销量 · 纵轴毛利率 · 气泡=净收入，点击查看详情）</h4>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
            <button onClick={() => setZoom(true)}>放大查看</button>
          </div>
          <Scatter data={data} onPick={onPick} activeId={activeId} big={false} quadrant={quadrant} />
          {zoom && (
            <div
              onClick={() => setZoom(false)}
              style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
            >
              <div className="panel" onClick={(e) => e.stopPropagation()} style={{ width: 'min(1100px, 100%)', maxHeight: '100%', overflow: 'auto' }}>
                <h4>
                  利润矩阵
                  <button onClick={() => setZoom(false)} style={{ marginLeft: 'auto' }}>关闭</button>
                </h4>
                <Scatter
                  data={data}
                  onPick={(id) => {
                    setZoom(false);
                    onPick(id);
                  }}
                  activeId={activeId}
                  big
                  quadrant={quadrant}
                />
              </div>
            </div>
          )}
        </div>
        <div className="panel">
          <h4>四象限与建议动作</h4>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            判断规则：用当前日期范围内所有产品的「销量中位数」和「毛利率中位数」作为分界线（图中虚线）。当前分界线：销量 {cuts.mu} 件，毛利率 {pct(cuts.mm)}。切换日期范围后分界线会变，产品所属象限可能随之变化。
          </div>
          <div style={{ fontSize: 12, marginBottom: 8 }}>
            {quadrant ? (
              <>
                <span className="muted">已按象限筛选：</span>
                <b>{quadrant}</b>
                <button className="link" style={{ marginLeft: 8 }} onClick={() => onQuadrant(null)}>清除筛选</button>
              </>
            ) : (
              <span className="muted">点击下表任一象限，可在矩阵、ABC 表和下方产品表中筛出该象限的产品</span>
            )}
          </div>
          <table className="plain">
            <thead><tr><th>象限</th><th className="n">产品数</th><th className="n">净收入 (USD)</th><th>判断条件</th><th>建议动作</th></tr></thead>
            <tbody>
              {quad.map((q) => (
                <tr
                  key={q.key}
                  className={quadrant === q.key ? 'active' : ''}
                  onClick={() => onQuadrant(quadrant === q.key ? null : q.key)}
                  title={q.names.join('、')}
                >
                  <td><span className="dot" style={{ background: q.color }} />{q.key}</td>
                  <td className="n">{q.n}</td>
                  <td className="n">{money(q.revenue)}</td>
                  <td style={{ whiteSpace: 'normal', minWidth: 180 }}>{cond[q.key]}</td>
                  <td style={{ whiteSpace: 'normal', minWidth: 220 }}>{q.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid2">
        <div className="panel">
          <h4>ABC 帕累托（按净收入累计占比）</h4>
          <table className="plain">
            <thead><tr><th>产品</th><th>净收入 (USD)</th><th className="n">累计占比</th><th>ABC</th><th>象限</th></tr></thead>
            <tbody>
              {shown.map((d) => (
                <tr key={d.id} className={activeId === d.id ? 'active' : ''} onClick={() => onPick(d.id)}>
                  <td>{d.title}</td>
                  <td><BarCell value={d.revenue} max={maxRev} text={money(d.revenue)} /></td>
                  <td className="n">{pct(d.cumShare)}</td>
                  <td>{d.abc}</td>
                  <td><span className="dot" style={{ background: colorOf(d.quadrant) }} />{d.quadrant}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h4>类目表现</h4>
          <table className="plain">
            <thead><tr><th>类目</th><th className="n">产品数</th><th>净收入 (USD)</th><th className="n">毛利率</th><th className="n">退款率</th></tr></thead>
            <tbody>
              {cats.map((c) => (
                <tr key={c.key}>
                  <td>{c.key}</td>
                  <td className="n">{c.n}</td>
                  <td><BarCell value={c.revenue} max={cats[0]?.revenue || 0} text={money(c.revenue)} /></td>
                  <td className="n">{pct(c.margin)}</td>
                  <td className={'n ' + (c.refundRate >= THRESH.refund ? 'neg' : '')}>{pct(c.refundRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4 style={{ marginTop: 14 }}>需关注产品（退款偏高 / 毛利偏低 / 环比下滑）</h4>
          {alerts.length === 0 ? (
            <div className="muted">暂无异常</div>
          ) : (
            <table className="plain">
              <thead><tr><th>产品</th><th>信号</th></tr></thead>
              <tbody>
                {alerts.map((d) => (
                  <tr key={d.id} onClick={() => onPick(d.id)}>
                    <td>{d.title}</td>
                    <td className="neg">{d.flags.filter((f) => f !== '环比上升' && f !== '复购强').join(' · ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        阈值：退款率 ≥ {pct(THRESH.refund)}、毛利率 &lt; {pct(THRESH.lowMargin)}、环比 ≤ {pct(THRESH.decline)}；象限以销量/毛利率中位数划分。库存、广告花费、浏览/加购漏斗接入真实数据后可继续扩展。
      </div>
    </div>
  );
}
