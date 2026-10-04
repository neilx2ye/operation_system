'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { DataTable, sortRows, type Column, type Sort } from '@/components/DataTable';
import { int, money } from '@/lib/format';
import { useHotReload } from '@/lib/useHotReload';
import { DataRefreshButton } from '@/components/DataRefreshButton';
import type { CustomerRow } from '@/lib/mock';
import styles from './userManager.module.css';

// ---------- 类型 ----------

type Group = { id: string; name: string; color: string };
type Store = { groups: Group[]; members: Record<string, string[]> };
type TagMap = Record<string, string[]>;
type GOp = { gid: string; ids: string[]; mode: 'add' | 'remove' };
type TOp = { tag: string; ids: string[]; mode: 'add' | 'remove' };
type Opt = { key: string; label: string; color?: string; state: 'all' | 'some' | 'none' };
type Rename = { kind: 'group' | 'tag'; key: string; draft: string };
type ApiResult = { ok: true; data: Store & { id?: string } } | { ok: false; error: string; id?: string };

const SCOPE_ALL = 'all';
const SCOPE_NONE = 'ungrouped';
const TAG_NONE = '__none__';
const DEFAULT_PAGE_SIZE = 20;
const MAX_NAME = 30;

const stop = (e: ReactMouseEvent) => e.stopPropagation();

// ---------- 弹出选择器（可搜索 / 三态勾选 / 现场新建） ----------

function PickerButton({
  label,
  className,
  disabled,
  placeholder,
  build,
  onToggle,
  onCreate,
}: {
  label: string;
  className: string;
  disabled?: boolean;
  placeholder: string;
  build: () => Opt[];
  onToggle: (o: Opt) => void;
  onCreate: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number }>({ left: 0 });
  const wrap = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) => !!wrap.current && t instanceof Node && wrap.current.contains(t);
    const down = (e: MouseEvent) => {
      if (!inside(e.target)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const away = (e: Event) => {
      if (!inside(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', away);
    };
  }, [open]);

  const toggleOpen = () => {
    if (!open && wrap.current) {
      const r = wrap.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left, window.innerWidth - 276));
      setPos(r.bottom + 340 > window.innerHeight && r.top > 340 ? { bottom: window.innerHeight - r.top + 4, left } : { top: r.bottom + 4, left });
      setText('');
    }
    setOpen((o) => !o);
  };

  const options = open ? build() : [];
  const q = text.trim();
  const ql = q.toLowerCase();
  const shown = q ? options.filter((o) => o.label.toLowerCase().includes(ql)) : options;
  const exact = options.some((o) => o.label.toLowerCase() === ql);

  return (
    <span ref={wrap} className={styles.pickWrap} onClick={stop}>
      <button type="button" className={className} disabled={disabled} onClick={toggleOpen}>
        {label}
      </button>
      {open && (
        <div className={styles.pop} style={pos}>
          <input
            type="text"
            autoFocus
            value={text}
            maxLength={MAX_NAME}
            placeholder={placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
              if (q && !exact) {
                onCreate(q);
                setText('');
              } else if (shown.length >= 1 && q) {
                onToggle(shown[0]);
              }
            }}
          />
          <div className={styles.popList}>
            {shown.map((o) => (
              <button type="button" key={o.key} className={styles.opt} onClick={() => onToggle(o)}>
                <span className={styles.box + (o.state === 'all' ? ' ' + styles.all : o.state === 'some' ? ' ' + styles.some : '')}>
                  {o.state === 'all' ? '✓' : o.state === 'some' ? '–' : ''}
                </span>
                {o.color && <span className={styles.dot} style={{ background: o.color }} />}
                <span className={styles.name}>{o.label}</span>
              </button>
            ))}
            {q && !exact && (
              <button
                type="button"
                className={styles.opt + ' ' + styles.create}
                onClick={() => {
                  onCreate(q);
                  setText('');
                }}
              >
                ＋ 新建「{q}」并应用
              </button>
            )}
            {shown.length === 0 && !q && <div className={styles.popEmpty}>还没有选项，输入名称后回车即可新建</div>}
          </div>
        </div>
      )}
    </span>
  );
}

// ---------- 主组件 ----------

export function UserManager() {
  const { version } = useHotReload();
  const [tick, setTick] = useState(0);
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tags, setTags] = useState<TagMap>({});
  const [store, setStore] = useState<Store>({ groups: [], members: {} });
  const storeRef = useRef<Store>(store);
  const tagsRef = useRef<TagMap>(tags);

  const [scope, setScope] = useState<string>(SCOPE_ALL);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>({ key: 'ltv', dir: -1 });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const [newGroup, setNewGroup] = useState('');
  const [renaming, setRenaming] = useState<Rename | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const dragIds = useRef<string[]>([]);

  const [toast, setToast] = useState<{ text: string; undo?: () => void; error?: boolean } | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const commitStore = useCallback((s: Store) => {
    storeRef.current = s;
    setStore(s);
  }, []);
  const commitTags = useCallback((t: TagMap) => {
    tagsRef.current = t;
    setTags(t);
  }, []);

  const notify = useCallback((text: string, undo?: () => void, error?: boolean) => {
    setToast({ text, undo, error });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), error ? 5000 : 8000);
  }, []);

  // ---------- 加载 ----------

  useEffect(() => {
    let alive = true;
    fetch('/api/customers')
      .then((r) => r.json())
      .then((customers: CustomerRow[]) => {
        if (!alive) return;
        setRows(customers);
        setLoading(false);
        // 客户列表拿到后才有可同步的 ID；未配置 Shopify 时服务端会退回本地 tags.json。
        return fetch('/api/tags?ids=' + encodeURIComponent(customers.map((r) => r.id).join(',')))
          .then((r) => r.json())
          .then((tagMap: TagMap) => {
            if (alive) commitTags(tagMap);
          });
      })
      .catch(() => alive && setLoading(false));
    fetch('/api/groups')
      .then((r) => r.json())
      .then((d: Store) => alive && commitStore(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [version, tick, commitStore, commitTags]);

  // ---------- 派生数据 ----------

  const groupIds = useMemo(() => new Set(store.groups.map((g) => g.id)), [store.groups]);
  const groupMap = useMemo(() => new Map(store.groups.map((g) => [g.id, g])), [store.groups]);
  const groupsOf = useCallback((id: string) => (store.members[id] || []).filter((g) => groupIds.has(g)), [store.members, groupIds]);

  const groupCounts = useMemo(() => {
    const m = new Map<string, number>();
    let ungrouped = 0;
    rows.forEach((r) => {
      const gs = groupsOf(r.id);
      if (gs.length === 0) ungrouped++;
      gs.forEach((g) => m.set(g, (m.get(g) || 0) + 1));
    });
    return { m, ungrouped };
  }, [rows, groupsOf]);

  const tagStats = useMemo(() => {
    const m = new Map<string, number>();
    let untagged = 0;
    rows.forEach((r) => {
      const ts = tags[r.id] || [];
      if (ts.length === 0) untagged++;
      ts.forEach((t) => m.set(t, (m.get(t) || 0) + 1));
    });
    const list = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return { list, untagged };
  }, [rows, tags]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      const gs = groupsOf(r.id);
      const ts = tags[r.id] || [];
      if (scope === SCOPE_NONE && gs.length) return false;
      if (scope !== SCOPE_ALL && scope !== SCOPE_NONE && !gs.includes(scope)) return false;
      if (tagFilter === TAG_NONE && ts.length) return false;
      if (tagFilter && tagFilter !== TAG_NONE && !ts.includes(tagFilter)) return false;
      if (q) {
        const hay = [r.email, r.country, r.source, ...gs.map((g) => groupMap.get(g)?.name || ''), ...ts].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, scope, tagFilter, query, tags, groupsOf, groupMap]);

  // 筛选变化：清空勾选、回到第 1 页
  useEffect(() => {
    setSelected((prev) => (prev.size === 0 ? prev : new Set()));
  }, [scope, tagFilter, query]);
  useEffect(() => {
    setPage(1);
  }, [scope, tagFilter, query, sort, pageSize]);

  // ---------- 分组操作 ----------

  const postGroups = useCallback(async (body: object): Promise<ApiResult> => {
    try {
      const res = await fetch('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data.error || '保存失败', id: data.id };
      return { ok: true, data };
    } catch {
      return { ok: false, error: '网络错误，保存失败' };
    }
  }, []);

  const runGroupOps = useCallback(
    async (ops: GOp[]) => {
      const prev = storeRef.current;
      const members = { ...prev.members };
      for (const op of ops) {
        for (const id of op.ids) {
          const cur = members[id] || [];
          const next = op.mode === 'add' ? (cur.includes(op.gid) ? cur : [...cur, op.gid]) : cur.filter((g) => g !== op.gid);
          if (next.length) members[id] = next;
          else delete members[id];
        }
      }
      commitStore({ ...prev, members });
      const r = await postGroups({ action: 'assign', ops });
      if (r.ok) commitStore({ groups: r.data.groups, members: r.data.members });
      else {
        commitStore(prev);
        notify(r.error, undefined, true);
      }
    },
    [commitStore, postGroups, notify],
  );

  const assignGroups = useCallback(
    (ids: string[], add: string[], remove: string[]) => {
      const { members, groups } = storeRef.current;
      const ops: GOp[] = [];
      const inverse: GOp[] = [];
      for (const gid of add) {
        const ch = ids.filter((id) => !(members[id] || []).includes(gid));
        if (ch.length) {
          ops.push({ gid, ids: ch, mode: 'add' });
          inverse.push({ gid, ids: ch, mode: 'remove' });
        }
      }
      for (const gid of remove) {
        const ch = ids.filter((id) => (members[id] || []).includes(gid));
        if (ch.length) {
          ops.push({ gid, ids: ch, mode: 'remove' });
          inverse.push({ gid, ids: ch, mode: 'add' });
        }
      }
      if (ops.length === 0) {
        notify('没有需要变更的用户');
        return;
      }
      const nameOf = (gid: string) => groups.find((g) => g.id === gid)?.name ?? '分组';
      const text = ops.map((o) => (o.mode === 'add' ? `${o.ids.length} 人加入「${nameOf(o.gid)}」` : `${o.ids.length} 人移出「${nameOf(o.gid)}」`)).join('；');
      void runGroupOps(ops);
      notify(text, () => {
        void runGroupOps(inverse);
        setToast(null);
      });
    },
    [runGroupOps, notify],
  );

  const createGroup = useCallback(
    async (name: string, assignTo?: string[]) => {
      const r = await postGroups({ action: 'create', name });
      let gid: string | undefined;
      if (r.ok) {
        commitStore({ groups: r.data.groups, members: r.data.members });
        gid = r.data.id;
      } else if (r.id) {
        gid = r.id;
      } else {
        notify(r.error, undefined, true);
        return;
      }
      if (gid && assignTo && assignTo.length) assignGroups(assignTo, [gid], []);
      else if (gid) setScope(gid);
    },
    [postGroups, commitStore, assignGroups, notify],
  );

  const renameGroup = async (id: string, name: string) => {
    const r = await postGroups({ action: 'rename', id, name });
    if (r.ok) commitStore({ groups: r.data.groups, members: r.data.members });
    else notify(r.error, undefined, true);
  };

  const deleteGroup = async (g: Group) => {
    const n = groupCounts.m.get(g.id) || 0;
    if (!window.confirm(`删除分组「${g.name}」？\n不会删除用户，只会解除 ${n} 人的归属。`)) return;
    const r = await postGroups({ action: 'delete', id: g.id });
    if (r.ok) {
      commitStore({ groups: r.data.groups, members: r.data.members });
      if (scope === g.id) setScope(SCOPE_ALL);
      notify(`已删除分组「${g.name}」`);
    } else notify(r.error, undefined, true);
  };

  // ---------- 标签操作 ----------

  const runTagOps = useCallback(
    async (ops: TOp[]) => {
      const prev = tagsRef.current;
      const next: TagMap = { ...prev };
      for (const op of ops) {
        for (const id of op.ids) {
          const cur = next[id] || [];
          const merged = op.mode === 'add' ? (cur.includes(op.tag) ? cur : [...cur, op.tag]) : cur.filter((t) => t !== op.tag);
          if (merged.length) next[id] = merged;
          else delete next[id];
        }
      }
      commitTags(next);
      try {
        let last: TagMap | null = null;
        for (const op of ops) {
          const res = await fetch('/api/tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(op.mode === 'add' ? { ids: op.ids, add: [op.tag] } : { ids: op.ids, remove: [op.tag] }),
          });
          if (!res.ok) throw new Error('save failed');
          last = (await res.json()) as TagMap;
        }
        if (last) commitTags(last);
      } catch {
        commitTags(prev);
        notify('标签保存失败，请检查服务端后重试', undefined, true);
      }
    },
    [commitTags, notify],
  );

  const assignTags = useCallback(
    (ids: string[], add: string[], remove: string[]) => {
      const cur = tagsRef.current;
      const ops: TOp[] = [];
      const inverse: TOp[] = [];
      for (const tag of add) {
        const ch = ids.filter((id) => !(cur[id] || []).includes(tag));
        if (ch.length) {
          ops.push({ tag, ids: ch, mode: 'add' });
          inverse.push({ tag, ids: ch, mode: 'remove' });
        }
      }
      for (const tag of remove) {
        const ch = ids.filter((id) => (cur[id] || []).includes(tag));
        if (ch.length) {
          ops.push({ tag, ids: ch, mode: 'remove' });
          inverse.push({ tag, ids: ch, mode: 'add' });
        }
      }
      if (ops.length === 0) {
        notify('没有需要变更的用户');
        return;
      }
      const text = ops.map((o) => (o.mode === 'add' ? `${o.ids.length} 人添加标签「${o.tag}」` : `${o.ids.length} 人移除标签「${o.tag}」`)).join('；');
      void runTagOps(ops);
      notify(text, () => {
        void runTagOps(inverse);
        setToast(null);
      });
    },
    [runTagOps, notify],
  );

  const renameTag = async (oldName: string, raw: string) => {
    const name = raw.trim().slice(0, MAX_NAME);
    if (!name || name === oldName) return;
    const ids = Object.keys(tagsRef.current).filter((id) => tagsRef.current[id].includes(oldName));
    try {
      const res = await fetch('/api/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, add: [name], remove: [oldName] }),
      });
      if (!res.ok) throw new Error('save failed');
      commitTags((await res.json()) as TagMap);
      if (tagFilter === oldName) setTagFilter(name);
      notify(`标签「${oldName}」已重命名为「${name}」（${ids.length} 人）`);
    } catch {
      notify('标签重命名失败', undefined, true);
    }
  };

  const deleteTag = async (tag: string) => {
    const ids = Object.keys(tagsRef.current).filter((id) => tagsRef.current[id].includes(tag));
    if (!window.confirm(`删除标签「${tag}」？\n将从 ${ids.length} 人身上移除该标签。`)) return;
    try {
      const res = await fetch('/api/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, remove: [tag] }),
      });
      if (!res.ok) throw new Error('save failed');
      commitTags((await res.json()) as TagMap);
      if (tagFilter === tag) setTagFilter(null);
      notify(`已删除标签「${tag}」`);
    } catch {
      notify('删除标签失败', undefined, true);
    }
  };

  // ---------- 选择器选项 ----------

  const stateOf = (ids: string[], has: (id: string) => boolean): Opt['state'] => {
    let n = 0;
    for (const id of ids) if (has(id)) n++;
    return n === 0 ? 'none' : n === ids.length ? 'all' : 'some';
  };

  const groupOptions = (ids: string[]): Opt[] =>
    store.groups.map((g) => ({ key: g.id, label: g.name, color: g.color, state: stateOf(ids, (id) => (store.members[id] || []).includes(g.id)) }));

  const tagOptions = (ids: string[]): Opt[] =>
    tagStats.list.map(([t]) => ({ key: t, label: t, state: stateOf(ids, (id) => (tags[id] || []).includes(t)) }));

  const toggleGroupOpt = (ids: string[], o: Opt) => (o.state === 'all' ? assignGroups(ids, [], [o.key]) : assignGroups(ids, [o.key], []));
  const toggleTagOpt = (ids: string[], o: Opt) => (o.state === 'all' ? assignTags(ids, [], [o.key]) : assignTags(ids, [o.key], []));
  const createTagFor = (ids: string[], name: string) => assignTags(ids, [name.trim().slice(0, MAX_NAME)], []);

  // ---------- 表格 ----------

  const columns = useMemo<Column<CustomerRow>[]>(
    () => [
      { key: 'email', label: '邮箱', cell: (r) => r.email },
      { key: 'country', label: '国家', cell: (r) => r.country },
      { key: 'source', label: '渠道', cell: (r) => r.source },
      { key: 'orders', label: '订单数', numeric: true, cell: (r) => r.orders },
      { key: 'ltv', label: 'LTV', numeric: true, cell: (r) => r.ltv, display: (r) => money(r.ltv) },
      {
        key: 'groups',
        label: '分组',
        cell: (r) => groupsOf(r.id).map((g) => groupMap.get(g)?.name || '').join(' '),
        display: (r) => (
          <span className={styles.cellChips} onClick={stop}>
            {groupsOf(r.id).map((gid) => {
              const g = groupMap.get(gid);
              if (!g) return null;
              return (
                <span key={gid} className={styles.chip} style={{ background: g.color + '22', color: g.color }}>
                  {g.name}
                  <button type="button" className={styles.x} title="移出该分组" onClick={() => assignGroups([r.id], [], [gid])}>
                    ×
                  </button>
                </span>
              );
            })}
            <PickerButton
              label="＋"
              className={styles.addBtn}
              placeholder="搜索或新建分组…"
              build={() => groupOptions([r.id])}
              onToggle={(o) => toggleGroupOpt([r.id], o)}
              onCreate={(name) => void createGroup(name, [r.id])}
            />
          </span>
        ),
      },
      {
        key: 'tags',
        label: '标签',
        cell: (r) => (tags[r.id] || []).join(' '),
        display: (r) => (
          <span className={styles.cellChips} onClick={stop}>
            {(tags[r.id] || []).map((t) => (
              <span key={t} className={styles.chip + ' ' + styles.tagChip}>
                {t}
                <button type="button" className={styles.x} title="移除该标签" onClick={() => assignTags([r.id], [], [t])}>
                  ×
                </button>
              </span>
            ))}
            <PickerButton
              label="＋"
              className={styles.addBtn}
              placeholder="搜索或新建标签…"
              build={() => tagOptions([r.id])}
              onToggle={(o) => toggleTagOpt([r.id], o)}
              onCreate={(name) => createTagFor([r.id], name)}
            />
          </span>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tags, store, groupsOf, groupMap, tagStats, assignGroups, assignTags, createGroup],
  );

  const sorted = useMemo(() => sortRows(filtered, columns, sort), [filtered, columns, sort]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const curPage = Math.min(page, pageCount);
  const pageRows = useMemo(() => sorted.slice((curPage - 1) * pageSize, curPage * pageSize), [sorted, curPage, pageSize]);
  const pagination = useMemo(
    () => ({ page: curPage, pageSize, total: sorted.length, onPageChange: setPage, onPageSizeChange: setPageSize }),
    [curPage, pageSize, sorted.length],
  );

  const selection = useMemo(() => ({ selected, onChange: (next: Set<string>) => setSelected(next) }), [selected]);
  const toggleRow = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selIds = useMemo(() => [...selected], [selected]);
  const pageAllSelected = pageRows.length > 0 && pageRows.every((r) => selected.has(r.id));
  const allFilteredSelected = sorted.length > 0 && sorted.every((r) => selected.has(r.id));

  // ---------- 拖拽 ----------

  const onRowDragStart = (row: CustomerRow, e: DragEvent<HTMLTableRowElement>) => {
    const ids = selected.has(row.id) ? [...selected] : [row.id];
    dragIds.current = ids;
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', ids.join(','));
    const ghost = document.createElement('div');
    ghost.textContent = `${ids.length} 位用户`;
    ghost.className = styles.dragGhost;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 10, 10);
    window.setTimeout(() => ghost.remove(), 0);
  };
  const onRowDragEnd = () => {
    dragIds.current = [];
    setDropKey(null);
  };
  const dropProps = (key: string, onDropIds: (ids: string[]) => void) => ({
    onDragOver: (e: DragEvent) => {
      if (!dragIds.current.length) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (dropKey !== key) setDropKey(key);
    },
    onDragLeave: () => setDropKey((k) => (k === key ? null : k)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const ids = dragIds.current;
      dragIds.current = [];
      setDropKey(null);
      if (ids.length) onDropIds(ids);
    },
  });

  // ---------- 渲染辅助 ----------

  const itemCls = (on: boolean, key: string) => styles.item + (on ? ' ' + styles.on : '') + (dropKey === key ? ' ' + styles.drop : '');

  const renameInput = (kind: 'group' | 'tag', key: string, commit: (v: string) => void) =>
    renaming && renaming.kind === kind && renaming.key === key ? (
      <input
        className={styles.renameInput}
        autoFocus
        value={renaming.draft}
        maxLength={MAX_NAME}
        onClick={stop}
        onChange={(e) => setRenaming({ ...renaming, draft: e.target.value })}
        onBlur={() => {
          commit(renaming.draft);
          setRenaming(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setRenaming(null);
        }}
      />
    ) : null;

  const scopeName =
    scope === SCOPE_ALL ? '全部用户' : scope === SCOPE_NONE ? '未分组' : `分组「${groupMap.get(scope)?.name ?? ''}」`;
  const hasFilter = scope !== SCOPE_ALL || tagFilter !== null || query.trim() !== '';

  return (
    <div className="content">
      <div className={styles.layout}>
        <aside className={styles.side}>
          <div className={styles.sideTitle}>分组</div>
          <div className={itemCls(scope === SCOPE_ALL, 'all')} onClick={() => setScope(SCOPE_ALL)}>
            <span className={styles.name}>全部用户</span>
            <span className={styles.count}>{int(rows.length)}</span>
          </div>
          <div
            className={itemCls(scope === SCOPE_NONE, 'none')}
            onClick={() => setScope(SCOPE_NONE)}
            title="拖到这里：解除所有分组"
            {...dropProps('none', (ids) => assignGroups(ids, [], store.groups.map((g) => g.id)))}
          >
            <span className={styles.name}>未分组</span>
            <span className={styles.count}>{int(groupCounts.ungrouped)}</span>
          </div>
          {store.groups.map((g) => (
            <div
              key={g.id}
              className={itemCls(scope === g.id, 'g:' + g.id)}
              onClick={() => setScope(g.id)}
              {...dropProps('g:' + g.id, (ids) => assignGroups(ids, [g.id], []))}
            >
              <span className={styles.dot} style={{ background: g.color }} />
              {renameInput('group', g.id, (v) => void (v.trim() && v.trim() !== g.name && renameGroup(g.id, v))) ?? (
                <span className={styles.name} title={g.name}>
                  {g.name}
                </span>
              )}
              <span className={styles.count}>{int(groupCounts.m.get(g.id) || 0)}</span>
              <span className={styles.itemActions} onClick={stop}>
                <button type="button" className={styles.iconBtn} title="重命名" onClick={() => setRenaming({ kind: 'group', key: g.id, draft: g.name })}>
                  ✎
                </button>
                <button type="button" className={styles.iconBtn} title="删除分组" onClick={() => void deleteGroup(g)}>
                  ✕
                </button>
              </span>
            </div>
          ))}
          <input
            className={styles.addInput}
            type="text"
            value={newGroup}
            maxLength={MAX_NAME}
            placeholder="＋ 新建分组，回车确认"
            onChange={(e) => setNewGroup(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && newGroup.trim()) {
                void createGroup(newGroup.trim());
                setNewGroup('');
              }
            }}
          />
          {store.groups.length === 0 && <div className={styles.hint}>还没有分组。先在上面新建一个，或直接勾选用户后在「分组」菜单里现场新建。</div>}

          <div className={styles.divider} />
          <div className={styles.sideTitle}>标签</div>
          <div className={itemCls(tagFilter === null, 'tag-all')} onClick={() => setTagFilter(null)}>
            <span className={styles.name}>全部</span>
          </div>
          <div className={itemCls(tagFilter === TAG_NONE, 'tag-none')} onClick={() => setTagFilter(tagFilter === TAG_NONE ? null : TAG_NONE)}>
            <span className={styles.name}>无标签</span>
            <span className={styles.count}>{int(tagStats.untagged)}</span>
          </div>
          {tagStats.list.map(([t, n]) => (
            <div
              key={t}
              className={itemCls(tagFilter === t, 't:' + t)}
              onClick={() => setTagFilter(tagFilter === t ? null : t)}
              {...dropProps('t:' + t, (ids) => assignTags(ids, [t], []))}
            >
              {renameInput('tag', t, (v) => void renameTag(t, v)) ?? (
                <span className={styles.name} title={t}>
                  # {t}
                </span>
              )}
              <span className={styles.count}>{int(n)}</span>
              <span className={styles.itemActions} onClick={stop}>
                <button type="button" className={styles.iconBtn} title="重命名" onClick={() => setRenaming({ kind: 'tag', key: t, draft: t })}>
                  ✎
                </button>
                <button type="button" className={styles.iconBtn} title="删除标签" onClick={() => void deleteTag(t)}>
                  ✕
                </button>
              </span>
            </div>
          ))}
          {tagStats.list.length === 0 && <div className={styles.hint}>还没有标签。勾选用户后在「打标签」菜单里输入名称即可创建。</div>}
        </aside>

        <section className={styles.main}>
          <div className={styles.toolbar}>
            <input type="text" value={query} placeholder="搜索邮箱 / 国家 / 渠道 / 分组 / 标签…" onChange={(e) => setQuery(e.target.value)} />
            <DataRefreshButton onDone={() => setTick((t) => t + 1)} />
            <span className={styles.crumbs}>
              {loading ? '加载中…' : `${scopeName}${tagFilter ? ' · ' + (tagFilter === TAG_NONE ? '无标签' : '#' + tagFilter) : ''} · 共 ${int(sorted.length)} 人`}
              {hasFilter && (
                <button
                  type="button"
                  className="link-underline"
                  onClick={() => {
                    setScope(SCOPE_ALL);
                    setTagFilter(null);
                    setQuery('');
                  }}
                >
                  清除筛选
                </button>
              )}
            </span>
          </div>

          {selected.size > 0 && (
            <div className={styles.selBar}>
              <b>已选 {int(selected.size)} 人</b>
              <PickerButton
                label="分组 ▾"
                className={styles.barBtn}
                placeholder="搜索或新建分组…"
                build={() => groupOptions(selIds)}
                onToggle={(o) => toggleGroupOpt(selIds, o)}
                onCreate={(name) => void createGroup(name, selIds)}
              />
              <PickerButton
                label="打标签 ▾"
                className={styles.barBtn}
                placeholder="搜索或新建标签…"
                build={() => tagOptions(selIds)}
                onToggle={(o) => toggleTagOpt(selIds, o)}
                onCreate={(name) => createTagFor(selIds, name)}
              />
              <span className={styles.grow} />
              <button type="button" className={styles.barBtn} onClick={() => setSelected(new Set())}>
                取消选择
              </button>
            </div>
          )}

          {pageAllSelected && sorted.length > pageRows.length && (
            <div className={styles.banner}>
              {allFilteredSelected ? (
                <>
                  已选择全部 {int(sorted.length)} 人。<button type="button" onClick={() => setSelected(new Set())}>清除选择</button>
                </>
              ) : (
                <>
                  已选择本页 {pageRows.length} 人。<button type="button" onClick={() => setSelected(new Set(sorted.map((r) => r.id)))}>选择筛选结果中的全部 {int(sorted.length)} 人</button>
                </>
              )}
            </div>
          )}

          <DataTable
            columns={columns}
            rows={pageRows}
            sort={sort}
            onSortChange={setSort}
            rowKey={(r) => r.id}
            onRowClick={(r) => toggleRow(r.id)}
            selection={selection}
            pagination={pagination}
            onRowDragStart={onRowDragStart}
            onRowDragEnd={onRowDragEnd}
            empty={loading ? '加载中…' : '没有匹配的用户'}
          />

          <div className={styles.tip}>
            操作提示：点击一行即可勾选；勾选后用顶部条批量分组 / 打标签；也可以把用户直接拖到左侧的分组或标签上。每次操作后 8 秒内可点「撤销」。可多选分组，一个用户可以属于多个分组。
          </div>
        </section>
      </div>

      {toast && (
        <div className={styles.toast + (toast.error ? ' ' + styles.error : '')} role="status">
          <span>{toast.text}</span>
          {toast.undo && (
            <button type="button" onClick={toast.undo}>
              撤销
            </button>
          )}
        </div>
      )}
    </div>
  );
}
