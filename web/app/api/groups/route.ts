import { NextResponse } from 'next/server';
import { readGroups, writeGroups, type GroupStore } from '@/lib/db/docs';

export const dynamic = 'force-dynamic';

// 客户分组存储：PostgreSQL 表 ops_customer_groups / ops_customer_group_members
//（file 后端回落 data/groups.json）。
// groups 是分组定义，members 是 { [customerId]: groupId[] }（一个客户可属于多个分组）。
type Store = GroupStore;

const COLORS = ['#3b82f6', '#16a34a', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];
const MAX_NAME = 30;

async function load(): Promise<Store> {
  return readGroups();
}

async function save(store: Store) {
  await writeGroups(store);
}

// 串行化写入，避免并发请求互相覆盖
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

const cleanName = (v: unknown) => String(v ?? '').trim().slice(0, MAX_NAME);
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function GET() {
  return NextResponse.json(await load());
}

/**
 * body:
 *  { action: 'create', name }
 *  { action: 'rename', id, name }
 *  { action: 'delete', id }
 *  { action: 'assign', ops: [{ gid, ids: string[], mode: 'add' | 'remove' }] }
 * 返回完整 Store；create 额外返回 id。
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.action !== 'string') {
    return NextResponse.json({ error: 'action required' }, { status: 400 });
  }

  return serial(async () => {
    const store = await load();

    if (body.action === 'create') {
      const name = cleanName(body.name);
      if (!name) return NextResponse.json({ error: '分组名不能为空' }, { status: 400 });
      const dup = store.groups.find((g) => sameName(g.name, name));
      if (dup) return NextResponse.json({ error: '分组已存在', id: dup.id }, { status: 409 });
      const id = 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      store.groups.push({ id, name, color: COLORS[store.groups.length % COLORS.length] });
      await save(store);
      return NextResponse.json({ ...store, id });
    }

    if (body.action === 'rename') {
      const name = cleanName(body.name);
      const g = store.groups.find((x) => x.id === body.id);
      if (!g) return NextResponse.json({ error: '分组不存在' }, { status: 404 });
      if (!name) return NextResponse.json({ error: '分组名不能为空' }, { status: 400 });
      if (store.groups.some((x) => x.id !== g.id && sameName(x.name, name))) {
        return NextResponse.json({ error: '已有同名分组' }, { status: 409 });
      }
      g.name = name;
      await save(store);
      return NextResponse.json(store);
    }

    if (body.action === 'delete') {
      if (!store.groups.some((x) => x.id === body.id)) return NextResponse.json(store);
      store.groups = store.groups.filter((x) => x.id !== body.id);
      for (const cid of Object.keys(store.members)) {
        const next = store.members[cid].filter((g) => g !== body.id);
        if (next.length) store.members[cid] = next;
        else delete store.members[cid];
      }
      await save(store);
      return NextResponse.json(store);
    }

    if (body.action === 'assign') {
      if (!Array.isArray(body.ops)) return NextResponse.json({ error: 'ops required' }, { status: 400 });
      const valid = new Set(store.groups.map((g) => g.id));
      for (const op of body.ops as { gid?: unknown; ids?: unknown; mode?: unknown }[]) {
        const gid = String(op?.gid ?? '');
        if (!valid.has(gid) || !Array.isArray(op.ids)) continue;
        for (const cid of (op.ids as unknown[]).map(String)) {
          const cur = store.members[cid] || [];
          const next = op.mode === 'remove' ? cur.filter((g) => g !== gid) : [...new Set([...cur, gid])];
          if (next.length) store.members[cid] = next;
          else delete store.members[cid];
        }
      }
      await save(store);
      return NextResponse.json(store);
    }

    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  });
}
