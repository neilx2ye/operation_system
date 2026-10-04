'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { DataTable, downloadCsv, filterRows, sortRows, toCsv, type Column, type Sort } from '@/components/DataTable';
import { MiniTable } from '@/components/Sparkline';
import { CustomerInsights, matchFilters, segmentOf, type FilterKey, type Filters } from '@/components/CustomerInsights';
import { AudienceActions } from '@/components/customer-marketing/AudienceActions';
import { MarketingCard } from '@/components/customer-marketing/MarketingCard';
import {
  MARKETING_TAG_LABELS,
  MarketingStatusMissing,
  MarketingStatusTag,
  formatDateTime,
  marketingTagKind,
} from '@/components/customer-marketing/MarketingStatusTag';
import { useMarketingStatus } from '@/components/customer-marketing/useMarketingStatus';
import styles from '@/components/customer-marketing/customerMarketing.module.css';
import { TAG_NONE } from '@/lib/customer-segmentation';
import type { KlaviyoMarketingStatus } from '@/lib/edm/types';
import { int, money } from '@/lib/format';
import { useHotReload } from '@/lib/useHotReload';
import { DataRefreshButton } from '@/components/DataRefreshButton';
import type { CustomerDetail, CustomerRow } from '@/lib/mock';

type TagMap = Record<string, string[]>;

/** 默认每页行数：一次只渲染当前页 */
const DEFAULT_PAGE_SIZE = 20;

type DataSourceInfo = { source: 'mock' | 'shopify'; syncedAt: string | null };

/** 营销状态在排序 / 搜索 / CSV 里的文本；本地没有记录时是「未查询」，不猜一个结论 */
function marketingCellText(status: KlaviyoMarketingStatus | undefined): string {
  return status ? MARKETING_TAG_LABELS[marketingTagKind(status)] : '未查询';
}

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
  // 复选框多选（受众范围）与 selected（打开单人详情）是两个独立状态，绝不混用
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [dataSource, setDataSource] = useState<DataSourceInfo | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const { version } = useHotReload();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    fetch('/api/customers')
      .then((r) => r.json())
      .then((customers: CustomerRow[]) => {
        if (!alive) return;
        setRows(customers);
        setLoading(false);
        // 客户列表拿到后才有可同步的 ID；服务端会合并 Shopify Customer.tags 和本地缓存。
        return fetch('/api/tags?ids=' + encodeURIComponent(customers.map((r) => r.id).join(',')))
          .then((r) => r.json())
          .then((tagMap: TagMap) => {
            if (alive) setTags(tagMap);
          });
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    fetch('/api/data-source')
      .then((r) => r.json())
      .then((d: DataSourceInfo) => {
        if (alive) setDataSource(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [version, tick]);

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
  }, [selected, version, tick]);

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

  const tagsColumn = useMemo<Column<CustomerRow>>(
    () => ({
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
    }),
    [tags],
  );

  // 自由搜索只在这些列上匹配（与 @/lib/customer-segmentation 的 customerSearchText 一致）：
  // 营销状态列不参与搜索，否则状态缓存一加载就会改变命中行。
  const searchColumns = useMemo<Column<CustomerRow>[]>(() => [...BASE_COLUMNS, tagsColumn], [tagsColumn]);

  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    Object.values(tags).forEach((list) => list.forEach((t) => m.set(t, (m.get(t) || 0) + 1)));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [tags]);
  const knownTags = useMemo(() => tagCounts.map(([t]) => t), [tagCounts]);
  const untagged = useMemo(() => rows.filter((r) => !(tags[r.id] || []).length).length, [rows, tags]);

  // 先算出命中集合（不含营销状态，避免依赖成环），再按可见行批量取状态
  const visibleBase = useMemo(() => {
    let base = rows.filter((r) => matchFilters(r, filters));
    if (tagFilter === TAG_NONE) base = base.filter((r) => !(tags[r.id] || []).length);
    else if (tagFilter) base = base.filter((r) => (tags[r.id] || []).includes(tagFilter));
    return filterRows(base, searchColumns, query);
  }, [rows, query, filters, tagFilter, tags, searchColumns]);
  // 筛选 / 搜索 / 排序 / 每页条数变化后回到第一页
  useEffect(() => {
    setPage(1);
  }, [query, filters, tagFilter, sort, rows, pageSize]);

  // 当前页的客户 ID：只按不依赖营销状态的列预排序，避免「状态 -> 排序 -> 取哪些 ID -> 状态」成环
  const loadedIds = useMemo(
    () =>
      sortRows(visibleBase, searchColumns, sort)
        .slice((page - 1) * pageSize, page * pageSize)
        .map((r) => r.id),
    [visibleBase, searchColumns, sort, page, pageSize],
  );

  // 只查已加载客户的本地状态缓存：一次性批量请求，由 hook 去重、分片，绝不逐行请求
  const { statuses, loading: statusLoading, error: statusError, refresh: refreshStatuses } = useMarketingStatus(loadedIds);

  const columns = useMemo<Column<CustomerRow>[]>(
    () => [
      ...BASE_COLUMNS,
      tagsColumn,
      {
        key: 'marketing',
        label: '邮箱营销状态',
        cell: (r) => marketingCellText(statuses[r.id]),
        display: (r) => (statuses[r.id] ? <MarketingStatusTag status={statuses[r.id]} /> : <MarketingStatusMissing />),
      },
      {
        key: 'klaviyo',
        label: 'Klaviyo 匹配状态',
        cell: (r) => (statuses[r.id] ? '已匹配' : '未查询'),
        display: (r) => (statuses[r.id] ? <span className={styles.matched}>已匹配</span> : <MarketingStatusMissing />),
      },
      {
        key: 'syncedAt',
        label: '最近同步时间',
        cell: () => (dataSource?.source === 'mock' ? '演示数据' : (dataSource?.syncedAt ?? '')),
        display: () =>
          dataSource?.source === 'mock' ? '演示数据' : dataSource?.syncedAt ? formatDateTime(dataSource.syncedAt) : '—',
      },
    ],
    [tagsColumn, statuses, dataSource],
  );

  const visible = useMemo(() => sortRows(visibleBase, columns, sort), [visibleBase, columns, sort]);
  // 真正渲染到 DOM 的只有当前页；批量打标签 / CSV 导出仍然作用于完整的 visible
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const curPage = Math.min(page, pageCount);
  const shown = useMemo(() => visible.slice((curPage - 1) * pageSize, curPage * pageSize), [visible, curPage, pageSize]);
  const pagination = useMemo(
    () => ({ page: curPage, pageSize, total: visible.length, onPageChange: setPage, onPageSizeChange: setPageSize }),
    [curPage, pageSize, visible.length],
  );

  // 筛选 / 标签 / 自由搜索变化后，旧的勾选不再对应当前列表：清空并要求重新确认范围
  useEffect(() => {
    setSelectedIds((prev) => (prev.size === 0 ? prev : new Set()));
  }, [filters, tagFilter, query]);

  // 数据源刷新后丢掉已经不存在的客户 ID，避免勾选人数虚高
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const alive = new Set(rows.map((r) => r.id));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  const selection = useMemo(
    () => ({ selected: selectedIds, onChange: (next: Set<string>) => setSelectedIds(next) }),
    [selectedIds],
  );

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
    if (!tagFilter || tagFilter === TAG_NONE || visible.length === 0) return;
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
            <TagChip tag={`未打标签 ${untagged}`} on={tagFilter === TAG_NONE} onClick={() => setTagFilter(tagFilter === TAG_NONE ? null : TAG_NONE)} />
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
            {tagFilter && tagFilter !== TAG_NONE && <button onClick={bulkRemove}>从当前列表移除「{tagFilter}」</button>}
          </div>
          {saveError && <div className="neg">标签保存失败，请检查服务端后重试</div>}
        </div>

        {dataSource?.source === 'mock' && (
          <div className={styles.mockBanner}>当前是演示数据 (Mock)：营销状态与受众只能用于流程模拟，不能推送到 Klaviyo。</div>
        )}

        <AudienceActions
          filters={filters}
          tag={tagFilter}
          query={query}
          filteredCount={visible.length}
          selectedIds={selectedIds}
          dataSource={dataSource?.source ?? null}
          onStatusRefreshed={refreshStatuses}
        />

        {selectedIds.size > 0 && (
          <div className={styles.selBar}>
            <span className={styles.selCount}>已勾选 {selectedIds.size} 位客户</span>
            <span className={styles.selNote}>受众与后续操作只作用于勾选的客户，未勾选的不受影响。</span>
            <button onClick={() => setSelectedIds(new Set())}>清除选择</button>
          </div>
        )}

        <div className="bar">
          <input type="text" placeholder="筛选邮箱 / 国家 / 渠道 / 分层 / 标签..." value={query} onChange={(e) => setQuery(e.target.value)} />
          <button onClick={() => downloadCsv('customers.csv', toCsv(columns, visible))}>导出 CSV</button>
          <DataRefreshButton onDone={() => setTick((t) => t + 1)} />
          <span className="muted">{loading ? '加载中...' : `共 ${visible.length} 行`}</span>
        </div>
        {(statusLoading || statusError) && (
          <div className={styles.statusLine}>
            {statusLoading && <span className={styles.muted}>邮箱营销状态读取中…（本地缓存，未查询的行显示「未查询」）</span>}
            {statusError && <span className={styles.danger}>邮箱营销状态读取失败：{statusError}（列表保留上一次读取结果）</span>}
          </div>
        )}
        <DataTable
          columns={columns}
          rows={shown}
          pagination={pagination}
          sort={sort}
          onSortChange={setSort}
          rowKey={(r) => r.id}
          activeKey={selected}
          onRowClick={(r) => setSelected(r.id === selected ? null : r.id)}
          selection={selection}
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
          <h4>Klaviyo 营销状态</h4>
          <MarketingCard status={statuses[detail.id] ?? null} />
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
