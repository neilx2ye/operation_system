'use client';

import { useEffect, useState } from 'react';
import { int, money, pct } from '@/lib/format';
import { BarCell, LineChart } from '@/components/LineChart';
import { DateRange } from '@/components/DateRange';
import { fmtIso, presetRange, type Range } from '@/lib/dateRange';
import type { SiteAnalytics } from '@/lib/shopifyAnalytics';

const T = { bounce: 0.6, cvrDrop: -0.15 };

const delta = (cur: number, prev: number) => (prev ? cur / prev - 1 : 0);

function Delta({ v, invert }: { v: number; invert?: boolean }) {
  const bad = invert ? v > 0 : v < 0;
  return <span className={bad ? 'neg' : 'pos'}>{(v >= 0 ? '▲ ' : '▼ ') + Math.abs(v * 100).toFixed(1) + '%'}</span>;
}

export function SiteView() {
  const maxIso = fmtIso(new Date());
  const [range, setRange] = useState<Range>(() => presetRange(14, maxIso));
  const [data, setData] = useState<SiteAnalytics | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    fetch(`/api/analytics/site?from=${range.from}&to=${range.to}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
        return j as SiteAnalytics;
      })
      .then((j) => {
        if (alive) setData(j);
      })
      .catch((e: any) => {
        if (alive) setErr(e?.message || String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [range.from, range.to]);

  const header = (
    <div className="insights page-wide">
      <DateRange value={range} maxIso={maxIso} onChange={setRange} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>站内分析</h3>
        <span className="muted" style={{ fontSize: 12 }}>流量质量 · 渠道 · 落地页 · 国家（数据源：Shopify 分析 API）</span>
      </div>
    </div>
  );

  if (err) {
    return (
      <>
        {header}
        <div className="insights page-wide">
          <div className="notice err">读取 Shopify 分析数据失败：{err}</div>
          <div className="muted" style={{ fontSize: 12 }}>请确认已配置 Shopify Admin Token，且具备 read_reports（或 read_analytics）权限。</div>
        </div>
      </>
    );
  }

  if (!data) {
    return (
      <>
        {header}
        <div className="insights page-wide muted">{loading ? '加载 Shopify 分析数据…' : '暂无数据'}</div>
      </>
    );
  }

  const c = data.totals;
  const p = data.prev;
  const daily = data.daily;
  const labels = daily.map((r) => r.iso.slice(5));
  const maxS = Math.max(...data.channels.map((x) => x.sessions), 1);
  const maxL = Math.max(...data.landings.map((x) => x.sessions), 1);
  const maxC = Math.max(...data.countries.map((x) => x.revenue), 1);

  const insights: string[] = [];
  const dCvr = delta(c.cvr, p.cvr);
  if (p.cvr && dCvr <= T.cvrDrop) insights.push(`整体转化率较上一周期下降 ${pct(-dCvr)}（${pct(p.cvr)} → ${pct(c.cvr)}），可下钻渠道 / 落地页定位。`);
  if (c.bounce >= T.bounce) insights.push(`整体跳出率 ${pct(c.bounce)} 偏高（阈值 ${pct(T.bounce)}）。`);
  const worst = [...data.channels].filter((x) => x.sessions > 0).sort((a, b) => a.cvr - b.cvr)[0];
  if (worst && data.channels.length > 1) insights.push(`转化率最低的渠道：${worst.channel}（会话 ${int(worst.sessions)}，转化率 ${pct(worst.cvr)}）。`);

  return (
    <div className="insights page-wide">
      <DateRange value={range} maxIso={maxIso} onChange={setRange} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>站内分析</h3>
        <span className="muted" style={{ fontSize: 12 }}>流量质量 · 渠道 · 落地页 · 国家（数据源：Shopify 分析 API）</span>
        {loading && <span className="muted" style={{ fontSize: 12 }}>刷新中…</span>}
      </div>

      <div className="kpis">
        <div className="kpi"><div className="kpi-label">会话数</div><div className="kpi-value">{int(c.sessions)}</div><div className="kpi-hint">较上期 <Delta v={delta(c.sessions, p.sessions)} /></div></div>
        <div className="kpi"><div className="kpi-label">转化率</div><div className="kpi-value">{pct(c.cvr)}</div><div className="kpi-hint">较上期 <Delta v={dCvr} /></div></div>
        <div className="kpi"><div className="kpi-label">订单数</div><div className="kpi-value">{int(c.orders)}</div><div className="kpi-hint">较上期 <Delta v={delta(c.orders, p.orders)} /></div></div>
        <div className="kpi"><div className="kpi-label">客单价</div><div className="kpi-value">{money(c.aov)}</div><div className="kpi-hint">较上期 <Delta v={delta(c.aov, p.aov)} /></div></div>
        <div className="kpi"><div className="kpi-label">销售额 (Shopify)</div><div className="kpi-value">{money(c.revenue)}</div><div className="kpi-hint">较上期 <Delta v={delta(c.revenue, p.revenue)} /></div></div>
      </div>

      <div className="panel" style={{ marginBottom: 12 }}>
        <h4>自动洞察（规则触发）</h4>
        {insights.length === 0 ? <div className="muted">暂无异常</div> : <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.8 }}>{insights.map((t, i) => <li key={i}>{t}</li>)}</ul>}
      </div>

      <div className="grid-half">
        <div className="panel">
          <h4>会话趋势</h4>
          <LineChart labels={labels} series={[{ name: '会话数', color: '#3b82f6', values: daily.map((r) => r.sessions) }]} height={150} />
          <h4 style={{ marginTop: 10 }}>订单趋势</h4>
          <LineChart labels={labels} series={[{ name: '订单数', color: '#16a34a', values: daily.map((r) => r.orders) }]} height={150} />
        </div>
        <div className="panel">
          <h4>转化率趋势</h4>
          <LineChart labels={labels} series={[{ name: '转化率', color: '#16a34a', values: daily.map((r) => r.cvr) }]} height={150} fmt={(v) => (v * 100).toFixed(1) + '%'} />
          <h4 style={{ marginTop: 10 }}>跳出率趋势</h4>
          <LineChart labels={labels} series={[{ name: '跳出率', color: '#dc2626', values: daily.map((r) => r.bounce) }]} height={150} fmt={(v) => (v * 100).toFixed(1) + '%'} />
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 12 }}>
        <h4>渠道（来源 referrer_source）</h4>
        <table className="plain">
          <thead><tr><th>渠道</th><th>会话</th><th className="n">转化率</th><th className="n">跳出率</th></tr></thead>
          <tbody>
            {data.channels.map((x) => (
              <tr key={x.channel}>
                <td>{x.channel}</td>
                <td><BarCell value={x.sessions} max={maxS} text={int(x.sessions)} /></td>
                <td className="n">{pct(x.cvr)}</td>
                <td className={'n ' + (x.bounce >= T.bounce ? 'neg' : '')}>{pct(x.bounce)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid-wide">
        <div className="panel">
          <h4>落地页表现</h4>
          <table className="plain">
            <thead><tr><th>页面</th><th>会话</th><th className="n">转化率</th></tr></thead>
            <tbody>
              {data.landings.map((l) => (
                <tr key={l.path}>
                  <td style={{ whiteSpace: 'normal' }}>{l.path}</td>
                  <td><BarCell value={l.sessions} max={maxL} text={int(l.sessions)} /></td>
                  <td className="n">{pct(l.cvr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h4>国家 / 地区（按账单国家）</h4>
          <table className="plain">
            <thead><tr><th>国家</th><th>销售额</th><th className="n">订单</th></tr></thead>
            <tbody>
              {data.countries.map((x) => (
                <tr key={x.name}>
                  <td>{x.name}</td>
                  <td><BarCell value={x.revenue} max={maxC} text={money(x.revenue)} /></td>
                  <td className="n">{int(x.orders)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="muted" style={{ fontSize: 12 }}>
        数据来自 Shopify 分析 API（ShopifyQL）。Shopify 不提供购买漏斗、设备类型、加购率、LCP 等埋点指标，故本页不含这些维度；如需请接入 GA4 / 前端埋点。
      </div>
    </div>
  );
}