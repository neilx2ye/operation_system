'use client';

import { useMemo, useState } from 'react';
import { int, money, pct } from '@/lib/format';
import type { CustomerRow } from '@/lib/mock';
import {
  FILTER_LABELS,
  SEGMENTS,
  cohortOf,
  matchFilters,
  segmentOf,
  type FilterKey,
  type Filters,
  type SegmentKey,
} from '@/lib/customer-segmentation';

// 分群与筛选规则已抽到 @/lib/customer-segmentation：页面与服务端必须共用同一份实现，
// 否则同一组筛选条件在页面和受众快照里会算出不同人数。
// 这里继续转出原来的名字，已有调用方（CustomersView 等）无需改动导入路径。
export { FILTER_LABELS, SEGMENTS, cohortOf, matchFilters, segmentOf };
export type { FilterKey, Filters, SegmentKey };

type Group = { key: string; n: number; revenue: number; avgLtv: number; repeatRate: number; refundRate: number };

function group(rows: CustomerRow[], keyOf: (r: CustomerRow) => string): Group[] {
  const m = new Map<string, CustomerRow[]>();
  rows.forEach((r) => {
    const k = keyOf(r);
    m.set(k, [...(m.get(k) || []), r]);
  });
  return [...m.entries()].map(([key, rs]) => {
    const revenue = rs.reduce((s, r) => s + r.ltv, 0);
    return {
      key,
      n: rs.length,
      revenue,
      avgLtv: revenue / rs.length,
      repeatRate: rs.filter((r) => r.orders >= 2).length / rs.length,
      refundRate: rs.filter((r) => r.refunds > 0).length / rs.length,
    };
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

function GroupTable({
  title,
  groups,
  labelHead,
  activeKey,
  onPick,
  step,
}: {
  title: string;
  groups: Group[];
  labelHead: string;
  activeKey?: string;
  onPick: (key: string) => void;
  /** 传入后默认只显示前 step 行，底部「加载更多」每次再加 step 行，直到全部展示 */
  step?: number;
}) {
  const [limit, setLimit] = useState(step ?? Infinity);
  const shown = step ? groups.slice(0, limit) : groups;
  const remaining = groups.length - shown.length;
  const maxLtv = Math.max(...groups.map((g) => g.avgLtv), 0);
  const maxRep = Math.max(...groups.map((g) => g.repeatRate), 0);
  return (
    <div className="panel">
      <h4>{title}</h4>
      <table className="plain">
        <thead>
          <tr>
            <th>{labelHead}</th>
            <th className="n">客户</th>
            <th>平均 LTV (USD)</th>
            <th>复购率</th>
            <th className="n">退款客户占比</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((g) => (
            <tr key={g.key} className={activeKey === g.key ? 'active' : ''} onClick={() => onPick(g.key)}>
              <td>{g.key}</td>
              <td className="n">{int(g.n)}</td>
              <td>
                <BarCell value={g.avgLtv} max={maxLtv} text={money(g.avgLtv)} />
              </td>
              <td>
                <BarCell value={g.repeatRate} max={maxRep} text={pct(g.repeatRate)} />
              </td>
              <td className={'n ' + (g.refundRate > 0.25 ? 'neg' : '')}>{pct(g.refundRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {step && groups.length > step && (
        <div className="muted" style={{ padding: '8px 0', textAlign: 'center' }}>
          {remaining > 0 ? (
            <>
              已显示 {shown.length} / {groups.length}{' '}
              <button className="link-underline" onClick={() => setLimit((n) => n + step)}>加载更多（再 {Math.min(step, remaining)} 条）</button>
            </>
          ) : (
            <>
              已显示全部 {groups.length} 条{' '}
              <button className="link-underline" onClick={() => setLimit(step)}>收起</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function CustomerInsights({
  rows: allRows,
  filters,
  onToggle,
  onClear,
}: {
  rows: CustomerRow[];
  filters: Filters;
  onToggle: (k: FilterKey, v: string) => void;
  onClear: () => void;
}) {
  const segment = filters.segment;
  const activeFilters = (Object.keys(filters) as FilterKey[]).filter((k) => filters[k]);
  const rows = useMemo(() => allRows.filter((r) => r.orders > 0), [allRows]);

  const s = useMemo(() => {
    const abandoners = allRows.filter((r) => r.abandons > 0);
    const abandonOnly = allRows.filter((r) => r.orders === 0).length;
    const abandonValue = abandoners.reduce((a, r) => a + r.abandonValue, 0);
    const n = rows.length;
    const revenue = rows.reduce((a, r) => a + r.ltv, 0);
    const sorted = [...rows].sort((a, b) => b.ltv - a.ltv);
    const topN = Math.max(1, Math.ceil(n * 0.2));
    const topRevenue = sorted.slice(0, topN).reduce((a, r) => a + r.ltv, 0);
    const repeat = rows.filter((r) => r.orders >= 2).length;
    const active30 = rows.filter((r) => r.daysSince != null && r.daysSince <= 30).length;
    const lapsed = rows.filter((r) => (r.daysSince ?? 0) > 90).length;
    const refundCust = rows.filter((r) => r.refunds > 0).length;

    const segs = SEGMENTS.map((def) => {
      const rs = allRows.filter((r) => segmentOf(r) === def.key);
      const rev = rs.reduce((a, r) => a + r.ltv, 0);
      return { ...def, n: rs.length, share: allRows.length ? rs.length / allRows.length : 0, revShare: revenue ? rev / revenue : 0 };
    });

    const cohorts = group(rows.filter((r) => r.firstOrder), (r) => (r.firstOrder as string).slice(0, 7)).sort((a, b) =>
      a.key.localeCompare(b.key),
    );

    return {
      n,
      revenue,
      avgLtv: n ? revenue / n : 0,
      topShare: revenue ? topRevenue / revenue : 0,
      topN,
      repeatRate: n ? repeat / n : 0,
      active30,
      lapsedRate: n ? lapsed / n : 0,
      refundRate: n ? refundCust / n : 0,
      segs,
      abandonN: abandoners.length,
      abandonOnly,
      abandonValue,
      channels: group(rows, (r) => r.source).sort((a, b) => b.revenue - a.revenue),
      countries: group(rows, (r) => r.country).sort((a, b) => b.revenue - a.revenue),
      cohorts,
    };
  }, [rows, allRows]);

  if (allRows.length === 0) return null;

  const kpis: { label: string; value: string; hint: string; warn?: boolean; filter?: boolean }[] = [
    { label: '客户数', value: int(s.n), hint: '近 30 天活跃 ' + int(s.active30) },
    { label: '净 LTV 合计 (USD)', value: money(s.revenue), hint: '人均 ' + money(s.avgLtv) },
    { label: '复购率', value: pct(s.repeatRate), hint: '订单数 ≥ 2 的客户占比' },
    { label: '头部 20% 客户贡献', value: pct(s.topShare), hint: '前 ' + int(s.topN) + ' 位客户的净收入占比' },
    { label: '沉睡占比', value: pct(s.lapsedRate), hint: '距上次购买 > 90 天', warn: s.lapsedRate > 0.5 },
    { label: '退款客户占比', value: pct(s.refundRate), hint: '至少退过 1 件', warn: s.refundRate > 0.25 },
    {
      label: '弃购用户（点击筛选）',
      value: int(s.abandonN),
      hint: '未成交 ' + int(s.abandonOnly) + ' 人 · 弃购金额 ' + money(s.abandonValue),
      filter: true,
    },
  ];

  const maxN = Math.max(...s.segs.map((x) => x.n), 1);
  const maxRep = Math.max(...s.cohorts.map((c) => c.repeatRate), 0.0001);

  return (
    <div className="insights">
      <div className="kpis">
        {kpis.map((k) => (
          <div
            className="kpi"
            key={k.label}
            style={k.filter ? { cursor: 'pointer', outline: filters.abandon ? '2px solid #f97316' : undefined } : undefined}
            onClick={k.filter ? () => onToggle('abandon', '1') : undefined}
          >
            <div className="kpi-label">{k.label}</div>
            <div className={'kpi-value ' + (k.warn ? 'neg' : '')}>{k.value}</div>
            <div className="kpi-hint">{k.hint}</div>
          </div>
        ))}
      </div>

      <div className="panel">
        <h4>
          用户分层（R/F/M 规则）
          {activeFilters.length > 0 && (
            <button className="link" onClick={onClear}>
              清除筛选：{activeFilters.map((k) => FILTER_LABELS[k] + '=' + filters[k]).join(' · ')}
            </button>
          )}
        </h4>
        <div className="stack">
          {s.segs
            .filter((x) => x.n > 0)
            .map((x) => (
              <div
                key={x.key}
                className={'stack-item' + (segment === x.key ? ' on' : '')}
                style={{ flex: x.n, background: x.color }}
                title={x.key + '：' + x.n + ' 人'}
                onClick={() => onToggle('segment', x.key)}
              />
            ))}
        </div>
        <table className="plain">
          <thead>
            <tr>
              <th>分层</th>
              <th>人数</th>
              <th className="n">人数占比</th>
              <th className="n">净收入占比</th>
              <th>建议动作</th>
            </tr>
          </thead>
          <tbody>
            {s.segs.map((x) => (
              <tr key={x.key} className={segment === x.key ? 'active' : ''} onClick={() => onToggle('segment', x.key)}>
                <td>
                  <span className="dot" style={{ background: x.color }} />
                  {x.key}
                </td>
                <td>
                  <BarCell value={x.n} max={maxN} text={int(x.n)} />
                </td>
                <td className="n">{pct(x.share)}</td>
                <td className="n">{pct(x.revShare)}</td>
                <td className="muted">{x.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid2">
        <GroupTable title="渠道用户质量（获客成本需接入广告花费后补充）" groups={s.channels} labelHead="渠道" activeKey={filters.source} onPick={(k) => onToggle('source', k)} step={10} />
        <GroupTable title="国家 / 地区" groups={s.countries} labelHead="国家" activeKey={filters.country} onPick={(k) => onToggle('country', k)} step={10} />
      </div>

      <div className="panel">
        <h4>首购月份 Cohort（越新的月份观察期越短，复购率偏低属正常）</h4>
        <table className="plain">
          <thead>
            <tr>
              <th>首购月</th>
              <th className="n">客户数</th>
              <th>复购率</th>
              <th className="n">平均 LTV (USD)</th>
              <th className="n">退款客户占比</th>
            </tr>
          </thead>
          <tbody>
            {s.cohorts.map((c) => (
              <tr key={c.key} className={filters.cohort === c.key ? 'active' : ''} onClick={() => onToggle('cohort', c.key)}>
                <td>{c.key}</td>
                <td className="n">{int(c.n)}</td>
                <td style={{ background: 'rgba(59,130,246,' + (0.08 + 0.5 * (c.repeatRate / maxRep)).toFixed(2) + ')' }}>{pct(c.repeatRate)}</td>
                <td className="n">{money(c.avgLtv)}</td>
                <td className="n">{pct(c.refundRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
