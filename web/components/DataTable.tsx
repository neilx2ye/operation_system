'use client';

import type { ReactNode } from 'react';

export type CellValue = string | number | null;

export type Column<T> = {
  key: string;
  label: string;
  numeric?: boolean;
  /** 原始值：用于排序、关键字筛选与 CSV 导出 */
  cell: (row: T) => CellValue;
  /** 显示内容，缺省时直接显示 cell */
  display?: (row: T) => ReactNode;
  /** 附加样式，例如环比的正负着色 */
  tone?: (row: T) => 'pos' | 'neg' | undefined;
};

export type Sort = { key: string; dir: 1 | -1 } | null;

export function filterRows<T>(rows: T[], columns: Column<T>[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => columns.some((c) => String(c.cell(row) ?? '').toLowerCase().includes(q)));
}

export function sortRows<T>(rows: T[], columns: Column<T>[], sort: Sort): T[] {
  if (!sort) return rows;
  const col = columns.find((c) => c.key === sort.key);
  if (!col) return rows;
  return rows.slice().sort((a, b) => {
    const x = col.cell(a);
    const y = col.cell(b);
    if (x == null) return 1;
    if (y == null) return -1;
    return (x > y ? 1 : x < y ? -1 : 0) * sort.dir;
  });
}

export function toCsv<T>(columns: Column<T>[], rows: T[]): string {
  const esc = (v: CellValue) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  return [columns.map((c) => esc(c.label)).join(','), ...rows.map((r) => columns.map((c) => esc(c.cell(r))).join(','))].join('\n');
}

export function downloadCsv(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function DataTable<T>({
  columns,
  rows,
  sort,
  onSortChange,
  rowKey,
  onRowClick,
  activeKey,
  empty = '没有匹配的数据',
}: {
  columns: Column<T>[];
  rows: T[];
  sort: Sort;
  onSortChange: (sort: Sort) => void;
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  activeKey?: string | null;
  empty?: string;
}) {
  if (rows.length === 0) return <div className="empty">{empty}</div>;

  const toggle = (key: string) => {
    onSortChange(sort && sort.key === key ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: -1 });
  };

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={c.numeric ? 'n' : undefined}
                onClick={() => toggle(c.key)}
                title="点击排序"
              >
                {c.label}
                {sort && sort.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            return (
              <tr
                key={key}
                className={key === activeKey ? 'active' : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((c) => {
                  const tone = c.tone?.(row);
                  const cls = [c.numeric ? 'n' : '', tone ?? ''].filter(Boolean).join(' ');
                  return (
                    <td key={c.key} className={cls || undefined}>
                      {c.display ? c.display(row) : (c.cell(row) ?? '-')}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}