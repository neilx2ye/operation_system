import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

// 客户标签存储：{ [customerId]: string[] }，落盘到 web/data/tags.json。
// 后续接 Postgres/Supabase 时，只需替换 load/save 两个函数。
const FILE = path.join(process.cwd(), 'data', 'tags.json');
type Store = Record<string, string[]>;

async function load(): Promise<Store> {
  try {
    return JSON.parse(await fs.readFile(FILE, 'utf8')) as Store;
  } catch {
    return {};
  }
}

async function save(store: Store) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
  await fs.rename(tmp, FILE);
}

const clean = (a: unknown): string[] =>
  Array.isArray(a) ? [...new Set(a.map((x) => String(x).trim().slice(0, 30)).filter(Boolean))] : [];

export async function GET() {
  return NextResponse.json(await load());
}

// body: { ids: string[], add?: string[], remove?: string[] }
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.ids)) {
    return NextResponse.json({ error: 'ids required' }, { status: 400 });
  }
  const add = clean(body.add);
  const remove = new Set(clean(body.remove));
  const store = await load();
  for (const id of body.ids.map(String)) {
    const next = [...new Set([...(store[id] || []), ...add])].filter((t) => !remove.has(t));
    if (next.length) store[id] = next;
    else delete store[id];
  }
  await save(store);
  return NextResponse.json(store);
}
