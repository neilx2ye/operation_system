'use client';

export type Series = { name: string; color: string; values: number[]; dashed?: boolean };

export function LineChart({ labels, series, height = 220, fmt = (v: number) => String(Math.round(v)) }: { labels: string[]; series: Series[]; height?: number; fmt?: (v: number) => string }) {
  const W = 640;
  const H = height;
  const P = { l: 52, r: 12, t: 12, b: 26 };
  const all = series.flatMap((s) => s.values);
  const max = Math.max(...all, 1) * 1.08;
  const min = Math.min(...all, 0);
  const n = labels.length;
  const x = (i: number) => P.l + (i / Math.max(n - 1, 1)) * (W - P.l - P.r);
  const y = (v: number) => H - P.b - ((v - min) / (max - min || 1)) * (H - P.t - P.b);
  const ticks = [0, 0.5, 1].map((t) => min + (max - min) * t);
  return (
    <div>
      <div style={{ display: 'flex', gap: 14, fontSize: 12, marginBottom: 4 }}>
        {series.map((s) => (
          <span key={s.name}>
            <span className="dot" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ height: 'auto' }}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke="#e5e7eb" />
            <text x={P.l - 6} y={y(t) + 4} textAnchor="end" fontSize={10} fill="#94a3b8">{fmt(t)}</text>
          </g>
        ))}
        {labels.map((l, i) =>
          i % Math.ceil(n / 8) === 0 ? (
            <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize={10} fill="#94a3b8">{l}</text>
          ) : null,
        )}
        {series.map((s) => (
          <polyline
            key={s.name}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeDasharray={s.dashed ? '5 4' : undefined}
            points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
          />
        ))}
      </svg>
    </div>
  );
}

export function BarCell({ value, max, text, color }: { value: number; max: number; text: string; color?: string }) {
  const w = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="bar-cell">
      <div className="bar-fill" style={{ width: w + '%', background: color }} />
      <span>{text}</span>
    </div>
  );
}
