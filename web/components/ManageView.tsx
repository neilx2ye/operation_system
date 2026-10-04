'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { int, money, pct } from '@/lib/format';
import { useHotReload } from '@/lib/useHotReload';
import type { CatalogRow } from '@/lib/mock';

type F = 'sku' | 'spu' | 'variant' | 'category' | 'price' | 'cost' | 'weightG' | 'stock' | 'reorderPoint' | 'leadTimeDays' | 'supplier' | 'status';
type Draft = Record<string, Partial<Record<F, string>>>;

const NUM: F[] = ['price', 'cost', 'weightG', 'stock', 'reorderPoint', 'leadTimeDays'];
const REQUIRED: F[] = ['sku', 'spu', 'category'];
const CSV_FIELDS: F[] = ['sku', 'spu', 'variant', 'category', 'price', 'cost', 'weightG', 'stock', 'reorderPoint', 'leadTimeDays', 'supplier', 'status'];
const STATUS = [
  { v: 'active', l: '在售' },
  { v: 'draft', l: '草稿' },
  { v: 'archived', l: '已下架' },
];
const STATUS_LABEL: Record<string, string> = { active: '在售', draft: '草稿', archived: '已下架' };
const statusTone = (s: string) => (s === 'active' ? 'green' : s === 'archived' ? 'red' : 'amber');

const SPU_KEY = (v: string) => v.trim() || '(未命名)';
const rangeMoney = (a: number, b: number) => (a === b ? money(a) : `${money(Math.min(a, b))} – ${money(Math.max(a, b))}`);
const variantPreview = (names: string[]) => {
  const list = names.map((n) => n.trim()).filter(Boolean);
  if (!list.length) return '—';
  const shown = list.slice(0, 3).join(' / ');
  return list.length > 3 ? `${shown} +${list.length - 3}` : shown;
};
const rangePct = (a: number | null, b: number | null) => (a == null || b == null ? '-' : a === b ? pct(a) : `${pct(Math.min(a, b))} – ${pct(Math.max(a, b))}`);

function Thumb({ imageUrl, name }: { imageUrl: string; name: string }) {
  return (
    <span className="catalog-thumb" title={name}>
      {imageUrl ? <img src={imageUrl} alt={name} loading="lazy" /> : <span>无图</span>}
    </span>
  );
}

function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur);
      cur = '';
      rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/** 同一 SPU 下多个 SKU 折叠为一行时的汇总信息。 */
type SpuGroup = {
  spu: string;
  rows: CatalogRow[];
  imageUrl: string;
  category: string;
  supplier: string;
  /** 各 SKU 状态一致时为该状态，否则为 'mixed'。 */
  status: string;
  priceMin: number;
  priceMax: number;
  costMin: number;
  costMax: number;
  stock: number;
  out: number;
  low: number;
  marginMin: number | null;
  marginMax: number | null;
};

export function ManageView() {
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [draft, setDraft] = useState<Draft>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [query, setQuery] = useState('');
  const [statusF, setStatusF] = useState('');
  const [onlyLow, setOnlyLow] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const fileRef = useRef<HTMLInputElement>(null);
  const { version } = useHotReload();

  const load = useCallback(() => {
    setLoading(true);
    return fetch('/api/catalog')
      .then((r) => r.json())
      .then((d: CatalogRow[]) => {
        setRows(d);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load, version]);

  const val = (r: CatalogRow, f: F) => draft[r.id]?.[f] ?? String(r[f]);
  const num = (r: CatalogRow, f: F) => Number(val(r, f));

  const setVal = (r: CatalogRow, f: F, v: string) => {
    setDraft((d) => {
      const cur = { ...(d[r.id] || {}) };
      if (v === String(r[f])) delete cur[f];
      else cur[f] = v;
      const next = { ...d };
      if (Object.keys(cur).length) next[r.id] = cur;
      else delete next[r.id];
      return next;
    });
  };

  const invalid = (r: CatalogRow, f: F) => {
    const v = val(r, f);
    if (NUM.includes(f)) return v.trim() === '' || !Number.isFinite(Number(v)) || Number(v) < 0;
    if (REQUIRED.includes(f)) return v.trim() === '';
    return false;
  };

  const stockState = (r: CatalogRow) => {
    if (val(r, 'status') !== 'active') return null;
    const s = num(r, 'stock');
    if (s <= 0) return { text: '缺货', cls: 'red' };
    if (s <= num(r, 'reorderPoint')) return { text: '需补货', cls: 'amber' };
    return { text: '正常', cls: 'green' };
  };

  const dirtyIds = Object.keys(draft);
  const hasInvalid = rows.some((r) => draft[r.id] && (Object.keys(draft[r.id]) as F[]).some((f) => invalid(r, f)));

  const kpi = useMemo(() => {
    const act = rows.filter((r) => val(r, 'status') === 'active');
    return {
      total: rows.length,
      active: act.length,
      value: act.reduce((s, r) => s + num(r, 'stock') * num(r, 'cost'), 0),
      out: act.filter((r) => num(r, 'stock') <= 0).length,
      low: act.filter((r) => num(r, 'stock') > 0 && num(r, 'stock') <= num(r, 'reorderPoint')).length,
      noCost: act.filter((r) => !(num(r, 'cost') > 0)).length,
      noWeight: act.filter((r) => !(num(r, 'weightG') > 0)).length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, draft]);

  const visible = rows.filter((r) => {
    if (statusF && val(r, 'status') !== statusF) return false;
    if (onlyLow) {
      const s = stockState(r);
      if (!s || s.cls === 'green') return false;
    }
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [val(r, 'sku'), val(r, 'spu'), val(r, 'variant'), val(r, 'category'), val(r, 'supplier')].join(' ').toLowerCase().includes(q);
  });

  /** 按 SPU 聚合（同一 SPU 的多个 SKU 折叠为一行；单 SKU 的 SPU 直接展示该行）。 */
  const groups = useMemo(() => {
    const map = new Map<string, CatalogRow[]>();
    for (const r of visible) {
      const key = SPU_KEY(val(r, 'spu'));
      const arr = map.get(key);
      if (arr) arr.push(r);
      else map.set(key, [r]);
    }
    return [...map.entries()].map(([spu, rs]): SpuGroup => {
      const prices = rs.map((r) => num(r, 'price'));
      const costs = rs.map((r) => num(r, 'cost'));
      const margins = rs
        .map((r) => (num(r, 'price') > 0 ? (num(r, 'price') - num(r, 'cost')) / num(r, 'price') : null))
        .filter((m): m is number => m != null);
      const uniq = (f: F) => new Set(rs.map((r) => val(r, f)));
      const cats = uniq('category');
      const sups = uniq('supplier');
      const stats = uniq('status');
      let out = 0;
      let low = 0;
      for (const r of rs) {
        const st = stockState(r);
        if (st?.cls === 'red') out++;
        else if (st?.cls === 'amber') low++;
      }
      return {
        spu,
        rows: rs,
        imageUrl: rs.find((r) => r.imageUrl)?.imageUrl || '',
        category: cats.size === 1 ? [...cats][0] : '多类目',
        supplier: sups.size === 1 ? [...sups][0] : '多供应商',
        status: stats.size === 1 ? [...stats][0] : 'mixed',
        priceMin: Math.min(...prices),
        priceMax: Math.max(...prices),
        costMin: Math.min(...costs),
        costMax: Math.max(...costs),
        stock: rs.reduce((s, r) => s + num(r, 'stock'), 0),
        out,
        low,
        marginMin: margins.length ? Math.min(...margins) : null,
        marginMax: margins.length ? Math.max(...margins) : null,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, draft]);

  const multiSpus = groups.filter((g) => g.rows.length > 1).map((g) => g.spu);
  const toggleSpu = (spu: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(spu)) n.delete(spu);
      else n.add(spu);
      return n;
    });

  // 搜索时自动展开命中的多 SKU SPU，方便直接看到匹配的变体。
  useEffect(() => {
    if (!query.trim()) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      let changed = false;
      groups.forEach((g) => {
        if (g.rows.length > 1 && !next.has(g.spu)) {
          next.add(g.spu);
          changed = true;
        }
      });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const save = async () => {
    if (!dirtyIds.length || hasInvalid) return;
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch('/api/catalog', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patches: draft }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '保存失败');
      setRows(j.rows);
      setDraft({});
      setMsg({ ok: true, text: `已保存 ${j.updated} 个 SKU，产品分析中的毛利、名称已按新参数计算` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
    setSaving(false);
  };

  const exportCsv = () => {
    const lines = [CSV_FIELDS.join(',')].concat(rows.map((r) => CSV_FIELDS.map((f) => csvCell(r[f])).join(',')));
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'catalog.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importCsv = async (file: File) => {
    const table = parseCsv(await file.text());
    if (table.length < 2) {
      setMsg({ ok: false, text: 'CSV 为空或缺少数据行' });
      return;
    }
    const head = table[0].map((h) => h.trim());
    const iSku = head.indexOf('sku');
    if (iSku < 0) {
      setMsg({ ok: false, text: 'CSV 需要包含 sku 列（按 SKU 编码匹配行）' });
      return;
    }
    const bySku = new Map(rows.map((r) => [r.sku, r]));
    const next: Draft = { ...draft };
    let hit = 0;
    let miss = 0;
    table.slice(1).forEach((line) => {
      const r = bySku.get((line[iSku] || '').trim());
      if (!r) {
        miss++;
        return;
      }
      hit++;
      const cur = { ...(next[r.id] || {}) };
      CSV_FIELDS.forEach((f) => {
        if (f === 'sku') return;
        const i = head.indexOf(f);
        if (i < 0) return;
        const v = (line[i] ?? '').trim();
        if (v === '' && f !== 'variant' && f !== 'supplier') return;
        if (v === String(r[f])) delete cur[f];
        else cur[f] = v;
      });
      if (Object.keys(cur).length) next[r.id] = cur;
      else delete next[r.id];
    });
    setDraft(next);
    setMsg({ ok: miss === 0, text: `已载入 ${hit} 行到编辑区${miss ? `，${miss} 行 SKU 未匹配已忽略` : ''}，确认后点「保存」才会生效` });
  };

  const cell = (r: CatalogRow, f: F, cls = '', type: 'text' | 'number' = 'text') => (
    <input
      className={['edit', cls, draft[r.id]?.[f] !== undefined ? 'dirty' : '', invalid(r, f) ? 'bad' : ''].filter(Boolean).join(' ')}
      type={type}
      min={type === 'number' ? 0 : undefined}
      step={f === 'price' || f === 'cost' ? '0.01' : type === 'number' ? '1' : undefined}
      value={val(r, f)}
      onChange={(e) => setVal(r, f, e.target.value)}
    />
  );

  return (
    <div className="content">
      <div className="insights">
        <div className="kpis">
          <div className="kpi"><div className="kpi-label">SKU 总数</div><div className="kpi-value">{kpi.total}</div><div className="kpi-hint">在售 {kpi.active} · SPU {groups.length}</div></div>
          <div className="kpi"><div className="kpi-label">在售库存成本值 (USD)</div><div className="kpi-value">{money(kpi.value)}</div><div className="kpi-hint">库存 × 成本</div></div>
          <div className="kpi"><div className="kpi-label">缺货</div><div className={'kpi-value ' + (kpi.out ? 'neg' : '')}>{kpi.out}</div></div>
          <div className="kpi"><div className="kpi-label">需补货</div><div className="kpi-value">{kpi.low}</div><div className="kpi-hint">库存 ≤ 补货点</div></div>
          <div className="kpi"><div className="kpi-label">未填成本</div><div className={'kpi-value ' + (kpi.noCost ? 'neg' : '')}>{kpi.noCost}</div><div className="kpi-hint">成本为 0 会高估毛利</div></div>
          <div className="kpi"><div className="kpi-label">未填重量</div><div className={'kpi-value ' + (kpi.noWeight ? 'neg' : '')}>{kpi.noWeight}</div><div className="kpi-hint">发货时按默认重量估算</div></div>
        </div>
      </div>

      <div className="bar">
        <input type="text" placeholder="搜索 SKU / 产品 / 变体 / 类目 / 供应商..." value={query} onChange={(e) => setQuery(e.target.value)} />
        <select value={statusF} onChange={(e) => setStatusF(e.target.value)} className="edit solid w-md">
          <option value="">全部状态</option>
          {STATUS.map((s) => (
            <option key={s.v} value={s.v}>{s.l}</option>
          ))}
        </select>
        <label><input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} /> 只看缺货/需补货</label>
        <button onClick={() => setExpanded(new Set(multiSpus))} disabled={!multiSpus.length}>展开全部</button>
        <button onClick={() => setExpanded(new Set())} disabled={!expanded.size}>折叠全部</button>
        <button onClick={exportCsv}>导出 CSV</button>
        <button onClick={() => fileRef.current?.click()}>导入 CSV</button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importCsv(f);
            e.target.value = '';
          }}
        />
        <span className="spacer" />
        <span className="muted">{loading ? '加载中...' : `${visible.length} 个 SKU / ${groups.length} 个 SPU`}</span>
        {dirtyIds.length > 0 && <span className="muted">待保存 {dirtyIds.length} 个 SKU</span>}
        <button disabled={!dirtyIds.length} onClick={() => setDraft({})}>放弃修改</button>
        <button className="primary" disabled={!dirtyIds.length || hasInvalid || saving} onClick={save}>
          {saving ? '保存中...' : '保存'}
        </button>
      </div>

      {msg && <div className={'notice ' + (msg.ok ? 'ok' : 'err')}>{msg.text}</div>}
      {hasInvalid && <div className="notice err">有字段不合法（红框）：数字需为大于等于 0 的数，SKU/产品名/类目不能为空</div>}

      <div className="table-wrap">
        <table className="plain manage-table">
          <thead>
            <tr>
              <th className="spu-toggle-cell" aria-label="展开 / 折叠"></th>
              <th>图片</th>
              <th>SKU</th>
              <th>产品名（SPU）</th>
              <th>变体</th>
              <th>类目</th>
              <th className="n">售价 (USD)</th>
              <th className="n">成本 (USD)</th>
              <th className="n">重量 (g)</th>
              <th className="n">毛利率</th>
              <th className="n">库存</th>
              <th>库存状态</th>
              <th className="n">补货点</th>
              <th className="n">供货周期(天)</th>
              <th>供应商</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const multi = g.rows.length > 1;
              const open = multi && expanded.has(g.spu);
              return (
                <Fragment key={g.spu}>
                  {multi && (
                    <tr className={'spu-row' + (open ? ' open' : '')} onClick={() => toggleSpu(g.spu)}>
                      <td className="spu-toggle-cell"><span className={'spu-toggle' + (open ? ' open' : '')} aria-hidden /></td>
                      <td className="spu-thumb-cell"><Thumb imageUrl={g.imageUrl} name={g.spu} /></td>
                      <td className="spu-head" colSpan={3}>
                        <div className="spu-head-main">
                          <span className="spu-name">{g.spu}</span>
                          <span className="pill">{g.rows.length} 个 SKU</span>
                          {g.rows.some((r) => draft[r.id]) && <span className="pill amber">待保存</span>}
                        </div>
                        <div className="spu-sub" title={g.rows.map((r) => val(r, 'variant')).filter(Boolean).join(' / ')}>
                          {variantPreview(g.rows.map((r) => val(r, 'variant')))}
                          {g.supplier && <><span className="spu-sep">·</span>{g.supplier}</>}
                        </div>
                      </td>
                      <td>{g.category}</td>
                      <td className="n">{rangeMoney(g.priceMin, g.priceMax)}</td>
                      <td className="n">{rangeMoney(g.costMin, g.costMax)}</td>
                      <td className="n muted">—</td>
                      <td className="n">{rangePct(g.marginMin, g.marginMax)}</td>
                      <td className="n">{int(g.stock)}</td>
                      <td>
                        {g.out > 0 && <span className="tag red">缺货 {g.out}</span>}
                        {g.low > 0 && <span className="tag amber" style={{ marginLeft: g.out > 0 ? 4 : 0 }}>需补货 {g.low}</span>}
                        {g.out === 0 && g.low === 0 && <span className="tag green">正常</span>}
                      </td>
                      <td className="n muted">—</td>
                      <td className="n muted">—</td>
                      <td className="muted">—</td>
                      <td>{g.status === 'mixed' ? <span className="muted">混合</span> : <span className={'tag ' + statusTone(g.status)}>{STATUS_LABEL[g.status] || g.status}</span>}</td>
                    </tr>
                  )}
                  {(!multi || open) &&
                    g.rows.map((r) => {
                      const price = num(r, 'price');
                      const cost = num(r, 'cost');
                      const margin = price > 0 ? (price - cost) / price : null;
                      const st = stockState(r);
                      const thumbName = val(r, 'spu') + (val(r, 'variant') ? ' - ' + val(r, 'variant') : '');
                      return (
                        <tr key={r.id} className={[draft[r.id] ? 'active' : '', multi ? 'sku-row' : ''].filter(Boolean).join(' ')}>
                          <td className="spu-toggle-cell">{multi && <span className="sku-indent" aria-hidden />}</td>
                          <td><Thumb imageUrl={r.imageUrl} name={thumbName} /></td>
                          <td>{cell(r, 'sku', 'w-md')}</td>
                          <td>{cell(r, 'spu', 'w-lg')}</td>
                          <td>{cell(r, 'variant', 'w-md')}</td>
                          <td>{cell(r, 'category', 'w-md')}</td>
                          <td className="n"><span className="muted">$ </span>{cell(r, 'price', '', 'number')}</td>
                          <td className="n"><span className="muted">$ </span>{cell(r, 'cost', '', 'number')}</td>
                          <td className="n">{cell(r, 'weightG', '', 'number')}</td>
                          <td className={'n ' + (margin != null && margin < 0.3 ? 'neg' : '')}>{margin == null ? '-' : pct(margin)}</td>
                          <td className="n">{cell(r, 'stock', '', 'number')}</td>
                          <td>{st ? <span className={'tag ' + st.cls}>{st.text}</span> : <span className="muted">-</span>}</td>
                          <td className="n">{cell(r, 'reorderPoint', '', 'number')}</td>
                          <td className="n">{cell(r, 'leadTimeDays', '', 'number')}</td>
                          <td>{cell(r, 'supplier', 'w-md')}</td>
                          <td>
                            <select
                              className={'edit w-md ' + (draft[r.id]?.status !== undefined ? 'dirty' : '')}
                              value={val(r, 'status')}
                              onChange={(e) => setVal(r, 'status', e.target.value)}
                            >
                              {STATUS.map((s) => (
                                <option key={s.v} value={s.v}>{s.l}</option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {!loading && visible.length === 0 && <div className="empty">没有匹配的 SKU</div>}

      <div className="muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.7 }}>
        说明：同一 SPU 下的多个 SKU 默认折叠为一行，点 SPU 行展开后可直接编辑每个变体（单 SKU 的 SPU 直接展示，无需展开）。库存 / 售价等列为聚合值，展开后按变体单独编辑。
        成本修改后会重算产品分析里的历史毛利（按当前成本计算）；售价修改只影响产品资料，已生成订单的成交价不变。“产品名 - 变体”展示名由 SPU 和变体自动拼接。
        导入 CSV 按 sku 列匹配行，列可以只包含需要批量修改的字段（建议先「导出 CSV」拿模板）。数据保存在 web/data/catalog.json。
      </div>
    </div>
  );
}
