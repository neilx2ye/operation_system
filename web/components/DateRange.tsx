'use client';

import { minIsoOf, presetRange, prevRange, type Range } from '@/lib/dateRange';

// 样式与产品分析页一致：.bar > .ranges（开始日期 - 结束日期 + 快捷按钮 + 全部）
const PRESETS = [
  { label: '近7天', days: 7 },
  { label: '近30天', days: 30 },
  { label: '近90天', days: 90 },
];

export function DateRange({ value, maxIso, onChange }: { value: Range; maxIso: string; onChange: (r: Range) => void }) {
  const minIso = minIsoOf(maxIso);
  const prev = prevRange(value);
  const noPrev = prev.from < minIso;

  const setFrom = (from: string) => {
    if (!from) return;
    onChange({ from, to: from > value.to ? from : value.to });
  };
  const setTo = (to: string) => {
    if (!to) return;
    onChange({ from: to < value.from ? to : value.from, to });
  };

  return (
    <div className="bar">
      <span className="ranges">
        <input type="date" value={value.from} min={minIso} max={maxIso} onChange={(e) => setFrom(e.target.value)} aria-label="开始日期" />
        -
        <input type="date" value={value.to} min={minIso} max={maxIso} onChange={(e) => setTo(e.target.value)} aria-label="结束日期" />
        {PRESETS.map((p) => (
          <button key={p.days} onClick={() => onChange(presetRange(p.days, maxIso))}>
            {p.label}
          </button>
        ))}
        <button onClick={() => onChange({ from: minIso, to: maxIso })}>全部</button>
      </span>
      <span className="muted">
        {noPrev ? <span className="neg">对比区间超出可用数据，环比不准</span> : `对比区间：${prev.from} ~ ${prev.to}`}
      </span>
    </div>
  );
}
