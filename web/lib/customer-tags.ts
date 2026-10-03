import path from 'node:path';
import { readJson } from '@/lib/edm/storage';

// 客户标签存储（web/data/tags.json）的只读访问。
// 写入仍由 /api/tags 负责；这里只让受众计算与页面共用同一份标签，避免两边筛选结果不一致。

const FILE = path.join(process.cwd(), 'data', 'tags.json');

export type TagMap = Record<string, string[]>;

export function loadTags(): TagMap {
  return readJson<TagMap>(FILE, {});
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