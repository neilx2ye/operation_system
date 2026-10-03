'use client';

import { useState, type DragEvent, type ReactNode } from 'react';

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

/** 可选的行多选。只有传入时才渲染复选框列。 */
export type RowSelection = {
  selected: ReadonlySet<string>;
  /** 回传新的集合；调用方负责保存。 */
  onChange: (next: Set<string>) => void;
};

/** 可选的分页。传入时 rows 只是当前页的行，total 是命中总数（页码从 1 开始）。 */
export type Pagination = {
  page: number;
  pageSize: number;
  total: number;
  pageSizeOptions?: number[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
};

function Pager({ page, pageSize, total, pageSizeOptions = [20, 50, 100, 200, 500], onPageChange, onPageSizeChange }: Pagination) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const cur = Math.min(Math.max(1, page), pages);
  const [jump, setJump] = useState('');
  const from = total === 0 ? 0 : (cur - 1) * pageSize + 1;
  const to = Math.min(total, cur * pageSize);
  const go = (p: number) => onPageChange(Math.min(pages, Math.max(1, p)));
  const doJump = () => {
    const n = parseInt(jump, 10);
    if (Number.isFinite(n)) go(n);
    setJump('');
  };
  return (
    <div className="bar" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, padding: '8px 0' }}>
      <span className="muted">
        第 {from}–{to} 条，共 {total} 条
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <select value={pageSize} onChange={(e) => onPageSizeChange(Number(e.target.value))} aria-label="每页条数">
          {pageSizeOptions.map((n) => (
            <option key={n} value={n}>
              {n} 条/页
            </option>
          ))}
        </select>
        <button onClick={() => go(1)} disabled={cur <= 1}>
          首页
        </button>
        <button onClick={() => go(cur - 1)} disabled={cur <= 1}>
          上一页
        </button>
        <span>
          {cur} / {pages}
        </span>
        <button onClick={() => go(cur + 1)} disabled={cur >= pages}>
          下一页
        </button>
        <button onClick={() => go(pages)} disabled={cur >= pages}>
          末页
        </button>
        <input
          type="text"
          inputMode="numeric"
          value={jump}
          placeholder="跳至"
          style={{ width: 56 }}
          onChange={(e) => setJump(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) doJump();
          }}
        />
        <button onClick={doJump} disabled={!jump}>
          跳转
        </button>
      </span>
    </div>
  );
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
  selection,
  pagination,
  onRowDragStart,
  onRowDragEnd,
}: {
  columns: Column<T>[];
  rows: T[];
  sort: Sort;
  onSortChange: (sort: Sort) => void;
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  activeKey?: string | null;
  empty?: string;
  /**
   * 省略时不渲染任何复选框，行为与之前完全一致（产品/订单/关系页面依赖这一点）。
   * 传入时表头复选框只作用于当前 rows（即当前可见行），行点击仍然是打开详情。
   */
  selection?: RowSelection;
  /** 省略时一次渲染全部 rows（其他页面行为不变） */
  pagination?: Pagination;
  /** 传入后行可拖拽（HTML5 drag & drop），用于把用户拖到分组 / 标签上 */
  onRowDragStart?: (row: T, e: DragEvent<HTMLTableRowElement>) => void;
  onRowDragEnd?: () => void;
}) {
  if (rows.length === 0) return <div className="empty">{empty}</div>;

  const toggle = (key: string) => {
    onSortChange(sort && sort.key === key ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: -1 });
  };

  const visibleKeys = selection ? rows.map(rowKey) : [];
  const selectedVisible = selection ? visibleKeys.filter((k) => selection.selected.has(k)).length : 0;
  const allSelected = visibleKeys.length > 0 && selectedVisible === visibleKeys.length;

  const toggleAll = () => {
    if (!selection) return;
    const next = new Set(selection.selected);
    if (allSelected) visibleKeys.forEach((k) => next.delete(k));
    else visibleKeys.forEach((k) => next.add(k));
    selection.onChange(next);
  };

  const toggleOne = (key: string) => {
    if (!selection) return;
    const next = new Set(selection.selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    selection.onChange(next);
  };

  return (
    <div className="table-wrap">
      {pagination && <Pager {...pagination} />}
      <table>
        <thead>
          <tr>
            {selection && (
              <th style={{ width: 34, cursor: 'default' }} title={pagination ? '全选 / 取消本页的行' : '全选 / 取消当前列表的全部行'}>
                <input
                  type="checkbox"
                  aria-label="全选当前列表"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = selectedVisible > 0 && !allSelected;
                  }}
                  onChange={toggleAll}
                />
              </th>
            )}
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
                className={[key === activeKey ? 'active' : '', selection?.selected.has(key) ? 'selected' : ''].filter(Boolean).join(' ') || undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                draggable={onRowDragStart ? true : undefined}
                onDragStart={onRowDragStart ? (e) => onRowDragStart(row, e) : undefined}
                onDragEnd={onRowDragEnd}
              >
                {selection && (
                  <td style={{ width: 34 }} onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label="选择该行"
                      checked={selection.selected.has(key)}
                      onChange={() => toggleOne(key)}
                    />
                  </td>
                )}
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
      {pagination && <Pager {...pagination} />}
    </div>
  );
}