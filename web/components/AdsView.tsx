'use client';

import { useMemo, useState } from 'react';
import { int, money, pct } from '@/lib/format';
import { BarCell, LineChart } from '@/components/LineChart';
import { CAMPAIGNS as CA0, GROSS_MARGIN, buildDaily, type CampaignRow, type Platform } from '@/lib/trafficMock';
import { DateRange } from '@/components/DateRange';
import { pick, presetRange, prevRange, type Range } from '@/lib/dateRange';

const BE_ROAS = 1 / GROSS_MARGIN;
const PCOLOR: Record<Platform, string> = { Google: '#3b82f6', Meta: '#8b5cf6', TikTok: '#111827' };
const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
const delta = (cur: number, prev: number) => (prev ? cur / prev - 1 : 0);

type Verdict = '加预算' | '观察' | '换素材' | '砸预算';
const VCOLOR: Record<Verdict, string> = { 加预算: '#16a34a', 观察: '#f59e0b', 换素材: '#3b82f6', 砸预算: '#dc2626' };

function judge(c: CampaignRow): { v: Verdict; why: string } {
  const roas = c.spend ? c.platformRevenue / c.spend : 0;
  if (roas < BE_ROAS) return { v: '砸预算', why: `ROAS ${roas.toFixed(2)} 低于盈亏平衡 ${BE_ROAS.toFixed(2)}` };
  if (c.frequency >= 3 || c.ctrTrend <= -0.15) return { v: '换素材', why: `频次 ${c.frequency.toFixed(1)} / CTR 趋势 ${pct(c.ctrTrend)}，素材疲劳` };
  if (roas >= BE_ROAS * 1.5 && c.frequency < 3 && c.ctrTrend > -0.1) return { v: '加预算', why: `ROAS ${roas.toFixed(2)} ≥ 1.5×盈亏平衡，频次与 CTR 健康` };
  return { v: '观察', why: `ROAS ${roas.toFixed(2)} 高于盈亏平衡但未达加预算条件` };
}

export function AdsView() {
  const daily = useMemo(() => buildDaily(90), []);
  const maxIso = daily[daily.length - 1].iso;
  const [platform, setPlatform] = useState<'all' | Platform>('all');
  const [range, setRange] = useState<Range>(() => presetRange(14, maxIso));

  const cur = pick(daily, range);
  const prev = pick(daily, prevRange(range));
  const agg = (rows: typeof daily) => {
    const spend = sum(rows.map((r) => r.spend));
    const pRev = sum(rows.map((r) => r.platformRevenue));
    const sRev = sum(rows.map((r) => r.revenue));
    return { spend, pRev, sRev, roas: spend ? pRev / spend : 0, mer: spend ? sRev / spend : 0 };
  };
  const c = agg(cur);
  const p = agg(prev);

  // 系列数据为近 30 天基准，按所选区间花费等比缩放（Mock；接入真实广告 API 后按区间直接查询）
  const base30 = sum(daily.slice(-30).map((r) => r.spend));
  const sc = base30 ? c.spend / base30 : 0;
  const CAMPAIGNS = CA0.map((x) => ({
    ...x,
    spend: x.spend * sc,
    impressions: Math.round(x.impressions * sc),
    clicks: Math.round(x.clicks * sc),
    orders: Math.round(x.orders * sc),
    platformRevenue: x.platformRevenue * sc,
  }));

  const camps = CAMPAIGNS.filter((x) => platform === 'all' || x.platform === platform);
  const rows = camps.map((x) => ({ ...x, roas: x.spend ? x.platformRevenue / x.spend : 0, cpa: x.orders ? x.spend / x.orders : 0, ctr: x.impressions ? x.clicks / x.impressions : 0, cpc: x.clicks ? x.spend / x.clicks : 0, ...judge(x) }));
  const maxSpend = Math.max(...rows.map((r) => r.spend), 1);

  const byPlatform = (['Google', 'Meta', 'TikTok'] as Platform[]).map((pl) => {
    const rs = CAMPAIGNS.filter((x) => x.platform === pl);
    const spend = sum(rs.map((r) => r.spend));
    const rev = sum(rs.map((r) => r.platformRevenue));
    const orders = sum(rs.map((r) => r.orders));
    const newOrders = sum(rs.map((r) => r.orders * r.newCustomerRate));
    return { pl, spend, rev, orders, roas: spend ? rev / spend : 0, cpa: orders ? spend / orders : 0, ncpa: newOrders ? spend / newOrders : 0 };
  });
  const totalSpend = sum(byPlatform.map((b) => b.spend));
  const platformOrders = sum(byPlatform.map((b) => b.orders));
  const shopifyOrders = sum(cur.map((r) => r.orders));
  const platformRevAll = sum(byPlatform.map((b) => b.rev));
  const shopifyRevAll = c.sRev;
  const overclaim = shopifyRevAll ? platformRevAll / shopifyRevAll - 1 : 0;

  const alerts = rows.filter((r) => r.v === '砸预算' || r.v === '换素材');

  return (
    <div className="insights page-wide">
      <DateRange value={range} maxIso={maxIso} onChange={setRange} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>广告分析</h3>
        <span className="muted" style={{ fontSize: 12 }}>花费 · 回报 · 素材 · 归因校准（站内行为请见「站内分析」）</span>
        <span style={{ marginLeft: 'auto' }} />
        {(['all', 'Google', 'Meta', 'TikTok'] as const).map((x) => (
          <button key={x} className={platform === x ? 'on' : ''} onClick={() => setPlatform(x)}>{x === 'all' ? '全部平台' : x}</button>
        ))}
      </div>

      <div className="kpis">
        <div className="kpi"><div className="kpi-label">总花费</div><div className="kpi-value">{money(c.spend)}</div><div className="kpi-hint">较上期 {pct(delta(c.spend, p.spend))}</div></div>
        <div className="kpi"><div className="kpi-label">平台归因 ROAS</div><div className="kpi-value">{c.roas.toFixed(2)}</div><div className="kpi-hint">盈亏平衡 {BE_ROAS.toFixed(2)}（毛利率 {pct(GROSS_MARGIN)}）</div></div>
        <div className="kpi"><div className="kpi-label">MER（Shopify 销售额/总花费）</div><div className="kpi-value">{c.mer.toFixed(2)}</div><div className="kpi-hint">较上期 {pct(delta(c.mer, p.mer))}</div></div>
        <div className="kpi"><div className="kpi-label">平台归因 vs Shopify</div><div className="kpi-value">{overclaim >= 0 ? '+' : ''}{pct(overclaim)}</div><div className="kpi-hint">平台合计销售额相对 Shopify 的偏差</div></div>
        <div className="kpi"><div className="kpi-label">需处理的系列</div><div className="kpi-value">{alerts.length}</div><div className="kpi-hint">砸预算 / 换素材</div></div>
      </div>

      <div className="grid-half">
        <div className="panel">
          <h4>花费 vs 销售额趋势</h4>
          <LineChart
            labels={cur.map((r) => r.date)}
            series={[
              { name: '花费', color: '#dc2626', values: cur.map((r) => r.spend) },
              { name: '平台归因销售额', color: '#8b5cf6', values: cur.map((r) => r.platformRevenue), dashed: true },
              { name: 'Shopify 销售额', color: '#16a34a', values: cur.map((r) => r.revenue) },
            ]}
            height={220}
            fmt={(v) => '$' + Math.round(v)}
          />
        </div>
        <div className="panel">
          <h4>平台对比</h4>
          <table className="plain">
            <thead><tr><th>平台</th><th>花费</th><th className="n">平台 ROAS</th><th className="n">CPA</th><th className="n">新客 CPA</th></tr></thead>
            <tbody>
              {byPlatform.map((b) => (
                <tr key={b.pl}>
                  <td><span className="dot" style={{ background: PCOLOR[b.pl] }} />{b.pl}</td>
                  <td><BarCell value={b.spend} max={totalSpend} text={money(b.spend)} color={PCOLOR[b.pl]} /></td>
                  <td className={'n ' + (b.roas < BE_ROAS ? 'neg' : '')}>{b.roas.toFixed(2)}</td>
                  <td className="n">{money(b.cpa)}</td>
                  <td className="n">{money(b.ncpa)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>平台订单合计 {int(platformOrders)}，Shopify 订单 {int(shopifyOrders)}（{range.from} ~ {range.to}）。差异过大时先检查 UTM / 归因窗口 / 重复归因。</div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 12 }}>
        <h4>系列决策表（规则自动判定）</h4>
        <table className="plain">
          <thead><tr><th>平台</th><th>系列</th><th>花费</th><th className="n">ROAS</th><th className="n">CPA</th><th className="n">CTR</th><th className="n">CPC</th><th className="n">新客占比</th><th className="n">频次</th><th className="n">CTR 趋势</th><th>建议</th><th>原因</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><span className="dot" style={{ background: PCOLOR[r.platform] }} />{r.platform}</td>
                <td>{r.campaign}</td>
                <td><BarCell value={r.spend} max={maxSpend} text={money(r.spend)} color={PCOLOR[r.platform]} /></td>
                <td className={'n ' + (r.roas < BE_ROAS ? 'neg' : '')}>{r.roas.toFixed(2)}</td>
                <td className="n">{money(r.cpa)}</td>
                <td className="n">{pct(r.ctr)}</td>
                <td className="n">{money(r.cpc)}</td>
                <td className="n">{pct(r.newCustomerRate)}</td>
                <td className={'n ' + (r.frequency >= 3 ? 'neg' : '')}>{r.frequency.toFixed(1)}</td>
                <td className={'n ' + (r.ctrTrend <= -0.15 ? 'neg' : '')}>{pct(r.ctrTrend)}</td>
                <td><span className="dot" style={{ background: VCOLOR[r.v] }} /><b>{r.v}</b></td>
                <td style={{ whiteSpace: 'normal', minWidth: 220 }}>{r.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="muted" style={{ fontSize: 12 }}>
        规则：盈亏平衡 ROAS = 1 ÷ 毛利率 = {BE_ROAS.toFixed(2)}；ROAS &lt; 盈亏平衡 → 砸预算；频次 ≥ 3 或 CTR 趋势 ≤ -15% → 换素材；ROAS ≥ 1.5× 且频次/CTR 健康 → 加预算。毛利率在 lib/trafficMock.ts 的 GROSS_MARGIN 中修改。当前为 Mock 数据。
      </div>
    </div>
  );
}
