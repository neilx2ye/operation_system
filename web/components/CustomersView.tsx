'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { DataTable, downloadCsv, filterRows, sortRows, toCsv, type Column, type Sort } from '@/components/DataTable';
import { MiniTable } from '@/components/Sparkline';
import { CustomerInsights, matchFilters, segmentOf, type FilterKey, type Filters } from '@/components/CustomerInsights';
import { int, money } from '@/lib/format';
import { useHotReload } from '@/lib/useHotReload';
import type { CustomerDetail, CustomerRow } from '@/lib/mock';

type TagMap = Record<string, string[]>;

const NO_TAG = '__none__';

const BASE_COLUMNS: Column<CustomerRow>[] = [
  { key: 'email', label: '邮箱', cell: (r) => r.email },
  { key: 'country', label: '国家', cell: (r) => r.country },
  { key: 'source', label: '渠道', cell: (r) => r.source },
  { key: 'segment', label: '分层', cell: (r) => segmentOf(r) },
  { key: 'orders', label: '订单数', numeric: true, cell: (r) => r.orders },
  { key: 'ltv', label: 'LTV', numeric: true, cell: (r) => r.ltv, display: (r) => money(r.ltv) },
  { key: 'refunds', label: '退款件数', numeric: true, cell: (r) => r.refunds },
  { key: 'firstOrder', label: '首单', cell: (r) => r.firstOrder },
  { key: 'lastOrder', label: '最近购买', cell: (r) => r.lastOrder },
  { key: 'daysSince', label: '距今天数', numeric: true, cell: (r) => r.daysSince, display: (r) => int(r.daysSince) },
  { key: 'abandons', label: '弃购次数', numeric: true, cell: (r) => r.abandons },
  { key: 'abandonValue', label: '弃购金额', numeric: true, cell: (r) => r.abandonValue, display: (r) => money(r.abandonValue) },
  { key: 'lastAbandon', label: '最近弃购', cell: (r) => r.lastAbandon },
];

function TagChip({ tag, onRemove, onClick, on }: { tag: string; onRemove?: (t: string) => void; onClick?: (t: string) => void; on?: boolean }) {
  return (
    <span className={'tag' + (on ? ' on' : '') + (onClick ? ' clickable' : '')} onClick={onClick ? () => onClick(tag) : undefined}>
      {tag}
      {onRemove && (
        <button
          className="tag-x"
          title="移除标签"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(tag);
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}

function TagEditor({
  tags,
  known,
  onAdd,
  onRemove,
}: {
  tags: string[];
  known: string[];
  onAdd: (t: string) => void;
  onRemove: (t: string) => void;
}) {
  const [text, setText] = useState('');
  const submit = () => {
    const t = text.trim();
    if (t) onAdd(t);
    setText('');
  };
  const suggestions = known.filter((t) => !tags.includes(t)).slice(0, 20);
  return (
    <div className="tag-editor">
      <div className="tag-list">
        {tags.length === 0 && <span className="muted">暂无标签</span>}
        {tags.map((t) => (
          <TagChip key={t} tag={t} onRemove={onRemove} />
        ))}
      </div>
      <div className="tag-input">
        <input
          type="text"
          value={text}
          placeholder="输入标签后回车添加"
          maxLength={30}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit();
          }}
        />
        <button onClick={submit}>添加</button>
      </div>
      {suggestions.length > 0 && (
        <div className="tag-list">
          <span className="muted">已有标签：</span>
          {suggestions.map((t) => (
            <TagChip key={t} tag={'+ ' + t} onClick={() => onAdd(t)} />
          ))}
        </div>
      )}
    </div>
  );
}

export function CustomersView() {
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>({ key: 'ltv', dir: -1 });
  const [selected, setSelected] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({});
  const onToggle = useCallback((k: FilterKey, v: string) => setFilters((f) => ({ ...f, [k]: f[k] === v ? undefined : v })), []);
  const onClear = useCallback(() => setFilters({}), []);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [tags, setTags] = useState<TagMap>({});
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [bulkText, setBulkText] = useState('');
  const [saveError, setSaveError] = useState(false);
  const { version } = useHotReload();

  useEffect(() => {
    let alive = true;
    fetch('/api/customers')
      .then((r) => r.json())
      .then((d: CustomerRow[]) => {
        if (alive) {
          setRows(d);
          setLoading(false);
        }
      });
    fetch('/api/tags')
      .then((r) => r.json())
      .then((d: TagMap) => {
        if (alive) setTags(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [version]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let alive = true;
    fetch(`/api/customers/${selected}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive) setDetail(d);
      });
    return () => {
      alive = false;
    };
  }, [selected, version]);

  const applyTags = useCallback((ids: string[], add: string[], remove: string[]) => {
    setTags((prev) => {
      const next = { ...prev };
      ids.forEach((id) => {
        const merged = [...new Set([...(next[id] || []), ...add])].filter((t) => !remove.includes(t));
        if (merged.length) next[id] = merged;
        else delete next[id];
      });
      return next;
    });
    fetch('/api/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, add, remove }),
    })
      .then((r) => {
        if (!r.ok) throw new Error('save failed');
        return r.json();
      })
      .then((d: TagMap) => {
        setTags(d);
        setSaveError(false);
      })
      .catch(() => setSaveError(true));
  }, []);

  const columns = useMemo<Column<CustomerRow>[]>(
    () => [
      ...BASE_COLUMNS,
      {
        key: 'tags',
        label: '标签',
        cell: (r) => (tags[r.id] || []).join(' '),
        display: (r) => (
          <span className="tag-list">
            {(tags[r.id] || []).map((t) => (
              <TagChip key={t} tag={t} />
            ))}
          </span>
        ),
      },
    ],
    [tags],
  );

  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    Object.values(tags).forEach((list) => list.forEach((t) => m.set(t, (m.get(t) || 0) + 1)));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [tags]);
  const knownTags = useMemo(() => tagCounts.map(([t]) => t), [tagCounts]);
  const untagged = useMemo(() => rows.filter((r) => !(tags[r.id] || []).length).length, [rows, tags]);

  const visible = useMemo(() => {
    let base = rows.filter((r) => matchFilters(r, filters));
    if (tagFilter === NO_TAG) base = base.filter((r) => !(tags[r.id] || []).length);
    else if (tagFilter) base = base.filter((r) => (tags[r.id] || []).includes(tagFilter));
    return sortRows(filterRows(base, columns, query), columns, sort);
  }, [rows, query, sort, filters, tagFilter, tags, columns]);

  const bulkAdd = () => {
    const t = bulkText.trim();
    if (!t || visible.length === 0) return;
    if (!window.confirm(`给当前列表的 ${visible.length} 位客户添加标签「${t}」？`)) return;
    applyTags(
      visible.map((r) => r.id),
      [t],
      [],
    );
    setBulkText('');
  };

  const bulkRemove = () => {
    if (!tagFilter || tagFilter === NO_TAG || visible.length === 0) return;
    if (!window.confirm(`从当前列表的 ${visible.length} 位客户中移除标签「${tagFilter}」？`)) return;
    applyTags(
      visible.map((r) => r.id),
      [],
      [tagFilter],
    );
  };

  return (
    <>
      <div className="content">
        <CustomerInsights rows={rows} filters={filters} onToggle={onToggle} onClear={onClear} />

        <div className="panel tag-bar">
          <div className="tag-list">
            <b>标签筛选</b>
            <TagChip tag={'全部'} on={tagFilter === null} onClick={() => setTagFilter(null)} />
            <TagChip tag={`未打标签 ${untagged}`} on={tagFilter === NO_TAG} onClick={() => setTagFilter(tagFilter === NO_TAG ? null : NO_TAG)} />
            {tagCounts.map(([t, n]) => (
              <span key={t} className="tag-wrap">
                <TagChip tag={`${t} ${n}`} on={tagFilter === t} onClick={() => setTagFilter(tagFilter === t ? null : t)} />
              </span>
            ))}
          </div>
          <div className="tag-input">
            <input
              type="text"
              value={bulkText}
              placeholder={`给当前列表 ${visible.length} 人批量打标签`}
              maxLength={30}
              onChange={(e) => setBulkText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) bulkAdd();
              }}
            />
            <button onClick={bulkAdd} disabled={!bulkText.trim() || visible.length === 0}>
              批量添加
            </button>
            {tagFilter && tagFilter !== NO_TAG && <button onClick={bulkRemove}>从当前列表移除「{tagFilter}」</button>}
          </div>
          {saveError && <div className="neg">标签保存失败，请检查服务端后重试</div>}
        </div>

        <div className="bar">
          <input type="text" placeholder="筛选邮箱 / 国家 / 渠道 / 分层 / 标签..." value={query} onChange={(e) => setQuery(e.target.value)} />
          <button onClick={() => downloadCsv('customers.csv', toCsv(columns, visible))}>导出 CSV</button>
          <span className="muted">{loading ? '加载中...' : `${visible.length} 行`}</span>
        </div>
        <DataTable
          columns={columns}
          rows={visible}
          sort={sort}
          onSortChange={setSort}
          rowKey={(r) => r.id}
          activeKey={selected}
          onRowClick={(r) => setSelected(r.id === selected ? null : r.id)}
        />
      </div>

      {detail && (
        <aside className="detail">
          <h3>{detail.email}</h3>
          <div className="muted">
            {detail.country} · {detail.source} · LTV {money(detail.ltv)} · {detail.orders} 单 · 退款 {detail.refunds} 件
          </div>
          <h4>标签</h4>
          <TagEditor
            tags={tags[detail.id] || []}
            known={knownTags}
            onAdd={(t) => applyTags([detail.id], [t], [])}
            onRemove={(t) => applyTags([detail.id], [], [t])}
          />
          <h4>购买过的产品</h4>
          <MiniTable
            rows={detail.products}
            columns={[
              { label: '产品', value: (p) => p.product },
              { label: '件数', numeric: true, value: (p) => p.units },
              { label: '净金额', numeric: true, value: (p) => money(p.amount) },
            ]}
          />
          <h4>行为时间线</h4>
          <MiniTable
            rows={detail.timeline}
            empty="暂无行为记录"
            columns={[
              { label: '日期', value: (t) => t.date },
              { label: '类型', value: (t) => t.type },
              { label: '内容', value: (t) => t.text },
            ]}
          />
        </aside>
      )}
    </>
  );
}
