import { readAllTags } from '@/lib/db/docs';

// 客户标签存储的只读访问（PostgreSQL 表 ops_customer_tags；file 后端回落 data/tags.json）。
// 写入由 /api/tags 负责；这里让受众计算与页面共用同一份标签，避免两边筛选结果不一致。

export type TagMap = Record<string, string[]>;

export async function loadTags(): Promise<TagMap> {
  return readAllTags();
}

export function tagGetter(tags: TagMap): (id: string) => string[] {
  return (id) => tags[id] ?? [];
}

/** 标签计数，按出现次数降序 */
export function tagCounts(tags: TagMap): [string, number][] {
  const m = new Map<string, number>();
  Object.values(tags).forEach((list) => list.forEach((t) => m.set(t, (m.get(t) || 0) + 1)));
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
