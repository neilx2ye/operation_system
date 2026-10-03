'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useHotReload } from '@/lib/useHotReload';

type Item = { label: string; href: string };
type Group = { label: string; children: Item[] };
type Entry = Item | Group;

type DataSource = { source: 'shopify' | 'mock'; syncedAt: string | null; counts: { products: number; customers: number; orders: number } };

/** 导航结构：有 children 的为可折叠分组，否则为普通链接 */
const NAV: Entry[] = [
  { href: '/orders', label: '订单查看' },
  {
    label: '产品',
    children: [
      { href: '/products', label: '产品分析' },
      { href: '/manage', label: '产品管理' },
    ],
  },
  {
    label: '用户',
    children: [
      { href: '/customers', label: '用户分析' },
      { href: '/users', label: '用户管理' },
      { href: '/edm', label: 'EDM 邮件设计' },
    ],
  },
  {
    label: '流量',
    children: [
      { href: '/site', label: '站内分析' },
      { href: '/ads', label: '广告分析' },
    ],
  },
  { href: '/settings', label: '设置' },
];

const isGroup = (e: Entry): e is Group => 'children' in e;

export function Nav() {
  const pathname = usePathname();
  const { status, version } = useHotReload();
  const [data, setData] = useState<DataSource | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const on = (href: string) => pathname.startsWith(href);

  useEffect(() => {
    fetch('/api/data-source')
      .then((r) => r.json())
      .then(setData)
      .catch(() => {});
  }, [version]);

  const brand = !data
    ? '加载中…'
    : data.source === 'shopify'
      ? `真实数据 · Shopify 同步于 ${data.syncedAt ? data.syncedAt.slice(0, 16).replace('T', ' ') : '—'}`
      : '演示数据 (Mock)';

  return (
    <header>
      <b>OPS 电商管理</b>
      <span className="brand-sub">
        {brand}
        {status !== 'off' && (
          <>
            {' · '}
            <span className={status === 'live' ? 'hot-on' : 'hot-off'}>
              {status === 'live' ? '热重载已连接' : '热重载连接中'}
            </span>
          </>
        )}
      </span>
      {NAV.map((e) => {
        if (!isGroup(e)) {
          return (
            <Link key={e.href} href={e.href} className={on(e.href) ? 'tab on' : 'tab'}>
              {e.label}
            </Link>
          );
        }
        const hasActive = e.children.some((c) => on(c.href));
        const expanded = open[e.label] ?? hasActive;
        return (
          <div key={e.label} className="tab-group">
            <button
              type="button"
              className={'tab-parent' + (hasActive ? ' has-on' : '')}
              aria-expanded={expanded}
              onClick={() => setOpen((o) => ({ ...o, [e.label]: !expanded }))}
            >
              <span>{e.label}</span>
              <span className="caret">{expanded ? '▾' : '▸'}</span>
            </button>
            {expanded && (
              <div className="tab-children">
                {e.children.map((c) => (
                  <Link key={c.href} href={c.href} className={on(c.href) ? 'tab sub on' : 'tab sub'}>
                    {c.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </header>
  );
}