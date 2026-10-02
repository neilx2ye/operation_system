'use client';

import type { ReactNode } from 'react';
import { money } from '@/lib/format';

export function Sparkline({ values, width = 430, height = 70 }: { values: number[]; width?: number; height?: number }) {
  const max = Math.max(...values, 1);
  const step = width / Math.max(values.length, 1);
  const bar = Math.max(step - 3, 1);
  return (
    <svg className="spark" width={width} height={height} role="img" aria-label="近 26 周净收入">
      {values.map((v, i) => {
        const h = Math.round((v / max) * (height - 10));
        return (
          <rect key={i} x={i * step} y={height - 6 - h} width={bar} height={h} fill="#3b82f6">
            <title>{money(v)}</title>
          </rect>
        );
      })}
    </svg>
  );
}

export function MiniTable<T>({
  columns,
  rows,
  empty = '暂无数据',
}: {
  columns: { label: string; numeric?: boolean; value: (row: T) => ReactNode }[];
  rows: T[];
  empty?: string;
}) {
  if (rows.length === 0) return <div className="muted">{empty}</div>;
  return (
    <table>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.label} className={c.numeric ? 'n' : undefined}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {columns.map((c) => (
              <td key={c.label} className={c.numeric ? 'n' : undefined}>
                {c.value(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}