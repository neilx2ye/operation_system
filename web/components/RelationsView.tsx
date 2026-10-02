'use client';

import { useEffect, useMemo, useState } from 'react';
import { DataTable, downloadCsv, filterRows, sortRows, toCsv, type Column, type Sort } from '@/components/DataTable';
import { useHotReload } from '@/lib/useHotReload';
import type { RelationRow } from '@/lib/mock';

const COLUMNS: Column<RelationRow>[] = [
  { key: 'a', label: '产品 A', cell: (r) => r.a },
  { key: 'b', label: '产品 B', cell: (r) => r.b },
  { key: 'count', label: '共同购买客户数', numeric: true, cell: (r) => r.count },
  { key: 'lift', label: 'Lift', numeric: true, cell: (r) => r.lift },
];

export function RelationsView() {
  const [rows, setRows] = useState<RelationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>({ key: 'count', dir: -1 });
  const { version } = useHotReload();

  useEffect(() => {
    let alive = true;
    fetch('/api/relations')
      .then((r) => r.json())
      .then((d: RelationRow[]) => {
        if (alive) {
          setRows(d);
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [version]);

  const visible = useMemo(() => sortRows(filterRows(rows, COLUMNS, query), COLUMNS, sort), [rows, query, sort]);

  return (
    <div className="content">
      <div className="bar">
        <input type="text" placeholder="筛选产品名..." value={query} onChange={(e) => setQuery(e.target.value)} />
        <button onClick={() => downloadCsv('relations.csv', toCsv(COLUMNS, visible))}>导出 CSV</button>
        <span className="muted">{loading ? '加载中...' : `${visible.length} 行`}</span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        同时购买过 A 与 B 的客户数；Lift &gt; 1 表示两个产品被一起购买的概率高于随机。
      </p>
      <DataTable columns={COLUMNS} rows={visible} sort={sort} onSortChange={setSort} rowKey={(r) => `${r.aId}|${r.bId}`} />
    </div>
  );
}