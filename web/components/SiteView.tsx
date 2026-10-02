'use client';

import { useMemo, useState } from 'react';
import { int, money, pct } from '@/lib/format';
import { BarCell, LineChart } from '@/components/LineChart';
import { CHANNELS as CH0, COUNTRIES as CO0, FUNNEL as FU0, LANDINGS as LA0, buildDaily } from '@/lib/trafficMock';
import { DateRange } from '@/components/DateRange';
import { pick, presetRange, prevRange, type Range } from '@/lib/dateRange';

const T = { bounce: 0.6, firstScreen: 0.3, lcp: 2.5, cvrDrop: -0.15 };

const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
const delta = (cur: number, prev: number) => (prev ? cur / prev - 1 : 0);

function Delta({ v, invert }: { v: number; invert?: boolean }) {
  const bad = invert ? v > 0 : v < 0;
  return <span className={bad ? 'neg' : 'pos'}>{(v >= 0 ? '▲ ' : '▼ ') + Math.abs(v * 100).toFixed(1) + '%'}</span>;
}

export function SiteView() {
  const daily = useMemo(() => buildDaily(90), []);
  const maxIso = daily[daily.length - 1].iso;
  const [range, setRange] = useState<Range>(() => presetRange(14, maxIso));
  const [device, setDevice] = useState<'all' | 'mobile' | 'desktop'>('all');

  const cur = pick(daily, range);
  const prev = pick(daily, prevRange(range));
  const k = (rows: typeof daily) => {
    const s = sum(rows.map((r) => r.sessions));
    const o = sum(rows.map((r) => r.orders));
    const rev = sum(rows.map((r) => r.revenue));
    return { s, o, rev, cvr: s ? o / s : 0, aov: o ? rev / o : 0 };
  };
  const c = k(cur);
  const p = k(prev);

  // 渠道/落地页/漏斗/国家为近 30 天基准数据，按所选区间会话量等比缩放（Mock；接入真实数据后按区间直接查询）
  const base30 = sum(daily.slice(-30).map((r) => r.sessions));
  const sc = base30 ? c.s / base30 : 0;
  const LANDINGS = LA0.map((l) => ({ ...l, sessions: Math.round(l.sessions * sc) }));
  const CHANNELS = CH0.map((x) => ({ ...x, sessions: Math.round(x.sessions * sc), orders: Math.round(x.orders * sc), revenue: x.revenue * sc }));
  const COUNTRIES = CO0.map((x) => ({ ...x, sessions: Math.round(x.sessions * sc) }));
  const FUNNEL = FU0.map((f) => ({ ...f, mobile: Math.round(f.mobile * sc), desktop: Math.round(f.desktop * sc) }));

  const funnel = FUNNEL.map((f, i) => {
    const v = device === 'mobile' ? f.mobile : device === 'desktop' ? f.desktop : f.mobile + f.desktop;
    const first = FUNNEL[0];
    const base = device === 'mobile' ? first.mobile : device === 'desktop' ? first.desktop : first.mobile + first.desktop;
    const prevV = i === 0 ? v : device === 'mobile' ? FUNNEL[i - 1].mobile : device === 'desktop' ? FUNNEL[i - 1].desktop : FUNNEL[i - 1].mobile + FUNNEL[i - 1].desktop;
    return { step: f.step, v, fromTop: base ? v / base : 0, step2step: prevV ? v / prevV : 1, mobile: f.mobile, desktop: f.desktop };
  });
  const worst = funnel.slice(1).reduce((a, b) => (b.step2step < a.step2step ? b : a));

  const insights = useMemo(() => {
    const out: string[] = [];
    const cvrChg = delta(c.cvr, p.cvr);
    if (cvrChg <= T.cvrDrop) out.push(`整体转化率较上一周期下降 ${pct(-cvrChg)}（${pct(p.cvr)} → ${pct(c.cvr)}），先按渠道/设备拆分定位。`);
    CHANNELS.filter((x) => x.kind === 'paid' && x.bounce >= T.bounce).forEach((x) => out.push(`${x.channel} 跳出率 ${pct(x.bounce)}，加购率仅 ${pct(x.addToCartRate)}：检查素材与落地页承诺是否一致。`));
    LANDINGS.filter((l) => l.firstScreenLoss >= T.firstScreen && l.mobileShare >= 0.7).forEach((l) => out.push(`${l.path} 移动端占比 ${pct(l.mobileShare)}、首屏流失 ${pct(l.firstScreenLoss)}、LCP ${l.lcp}s：优先优化首屏与加载速度。`));
    const m = FUNNEL[4].mobile / FUNNEL[3].mobile;
    const d = FUNNEL[4].desktop / FUNNEL[3].desktop;
    if (m < d - 0.1) out.push(`结账→填写支付环节：移动端 ${pct(m)} 显著低于桌面 ${pct(d)}，排查移动端结账表单/支付方式。`);
    return out;
  }, [c, p]);

  const maxS = Math.max(...CHANNELS.map((x) => x.sessions));
  const maxL = Math.max(...LANDINGS.map((x) => x.sessions));
  const maxF = funnel[0].v || 1;

  return (
    <div className="insights page-wide">
      <DateRange value={range} maxIso={maxIso} onChange={setRange} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>站内分析</h3>
        <span className="muted" style={{ fontSize: 12 }}>流量质量 · 页面表现 · 转化漏斗（广告花费与 ROAS 请见「广告分析」）</span>
        <span style={{ marginLeft: 'auto' }} />
      </div>

      <div className="kpis">
        <div className="kpi"><div className="kpi-label">会话数</div><div className="kpi-value">{int(c.s)}</div><div className="kpi-hint">较上期 <Delta v={delta(c.s, p.s)} /></div></div>
        <div className="kpi"><div className="kpi-label">转化率</div><div className="kpi-value">{pct(c.cvr)}</div><div className="kpi-hint">较上期 <Delta v={delta(c.cvr, p.cvr)} /></div></div>
        <div className="kpi"><div className="kpi-label">订单数</div><div className="kpi-value">{int(c.o)}</div><div className="kpi-hint">较上期 <Delta v={delta(c.o, p.o)} /></div></div>
        <div className="kpi"><div className="kpi-label">客单价</div><div className="kpi-value">{money(c.aov)}</div><div className="kpi-hint">较上期 <Delta v={delta(c.aov, p.aov)} /></div></div>
        <div className="kpi"><div className="kpi-label">销售额 (Shopify)</div><div className="kpi-value">{money(c.rev)}</div><div className="kpi-hint">较上期 <Delta v={delta(c.rev, p.rev)} /></div></div>
      </div>

      <div className="panel" style={{ marginBottom: 12 }}>
        <h4>自动洞察（规则触发）</h4>
        {insights.length === 0 ? <div className="muted">暂无异常</div> : <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.8 }}>{insights.map((t, i) => <li key={i}>{t}</li>)}</ul>}
      </div>

      <div className="grid-half">
        <div className="panel">
          <h4>会话与订单趋势</h4>
          <LineChart labels={cur.map((r) => r.date)} series={[{ name: '会话数', color: '#3b82f6', values: cur.map((r) => r.sessions) }]} height={160} />
          <LineChart labels={cur.map((r) => r.date)} series={[{ name: '转化率', color: '#16a34a', values: cur.map((r) => (r.sessions ? r.orders / r.sessions : 0)) }]} height={160} fmt={(v) => (v * 100).toFixed(1) + '%'} />
        </div>
        <div className="panel">
          <h4>购买漏斗
            <span style={{ marginLeft: 'auto' }} />
            {(['all', 'mobile', 'desktop'] as const).map((d) => (
              <button key={d} className={device === d ? 'on' : ''} onClick={() => setDevice(d)}>{d === 'all' ? '全部' : d === 'mobile' ? '移动端' : '桌面端'}</button>
            ))}
          </h4>
          <table className="plain">
            <thead><tr><th>步骤</th><th>人数</th><th className="n">占会话</th><th className="n">上一步转化</th></tr></thead>
            <tbody>
              {funnel.map((f) => (
                <tr key={f.step} className={f.step === worst.step ? 'active' : ''}>
                  <td>{f.step}</td>
                  <td><BarCell value={f.v} max={maxF} text={int(f.v)} /></td>
                  <td className="n">{pct(f.fromTop)}</td>
                  <td className={'n ' + (f.step === worst.step ? 'neg' : '')}>{f.step === '会话' ? '-' : pct(f.step2step)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>高亮行 = 相邻步骤流失最大的环节：<b>{worst.step}</b>（上一步转化 {pct(worst.step2step)}）</div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 12 }}>
        <h4>渠道流量质量（只看站内表现；花费/ROAS 在广告页）</h4>
        <table className="plain">
          <thead><tr><th>渠道</th><th>类型</th><th>会话</th><th className="n">新访客</th><th className="n">跳出率</th><th className="n">页/会话</th><th className="n">加购率</th><th className="n">转化率</th><th className="n">销售额</th></tr></thead>
          <tbody>
            {CHANNELS.map((x) => (
              <tr key={x.channel}>
                <td>{x.channel}</td>
                <td>{x.kind === 'paid' ? '付费' : '免费'}</td>
                <td><BarCell value={x.sessions} max={maxS} text={int(x.sessions)} /></td>
                <td className="n">{pct(x.newRate)}</td>
                <td className={'n ' + (x.bounce >= T.bounce ? 'neg' : '')}>{pct(x.bounce)}</td>
                <td className="n">{x.pagesPerSession.toFixed(1)}</td>
                <td className="n">{pct(x.addToCartRate)}</td>
                <td className="n">{pct(x.cvr)}</td>
                <td className="n">{money(x.revenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid-wide">
        <div className="panel">
          <h4>落地页表现</h4>
          <table className="plain">
            <thead><tr><th>页面</th><th>会话</th><th className="n">跳出</th><th className="n">首屏流失</th><th className="n">加购</th><th className="n">转化</th><th className="n">移动占比</th><th className="n">LCP</th></tr></thead>
            <tbody>
              {LANDINGS.map((l) => (
                <tr key={l.path}>
                  <td>{l.path}</td>
                  <td><BarCell value={l.sessions} max={maxL} text={int(l.sessions)} /></td>
                  <td className={'n ' + (l.bounce >= T.bounce ? 'neg' : '')}>{pct(l.bounce)}</td>
                  <td className={'n ' + (l.firstScreenLoss >= T.firstScreen ? 'neg' : '')}>{pct(l.firstScreenLoss)}</td>
                  <td className="n">{pct(l.addToCartRate)}</td>
                  <td className="n">{pct(l.cvr)}</td>
                  <td className="n">{pct(l.mobileShare)}</td>
                  <td className={'n ' + (l.lcp > T.lcp ? 'neg' : '')}>{l.lcp.toFixed(1)}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h4>国家 / 地区</h4>
          <table className="plain">
            <thead><tr><th>国家</th><th>会话</th><th className="n">转化率</th></tr></thead>
            <tbody>
              {COUNTRIES.map((x) => (
                <tr key={x.name}><td>{x.name}</td><td><BarCell value={x.sessions} max={COUNTRIES[0].sessions} text={int(x.sessions)} /></td><td className="n">{pct(x.cvr)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="muted" style={{ fontSize: 12 }}>
        红色阈值：跳出率 ≥ {pct(T.bounce)}、首屏流失 ≥ {pct(T.firstScreen)}、LCP &gt; {T.lcp}s。当前为 Mock 数据，接入 GA4 / Shopify 后在 lib/trafficMock.ts 替换数据源即可。
      </div>
    </div>
  );
}
