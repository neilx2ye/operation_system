import { createFileRepositories } from './file';
import { createMemoryRepositories } from './memory';
import type { Repositories } from './types';

// 存储入口：进程内只创建一个实例，页面与路由通过 service.ts 间接使用。

export * from './types';

let cached: Repositories | null = null;

export function getRepositories(): Repositories {
  if (!cached) {
    cached = process.env.OPS_EDM_MEMORY_STORE === '1' ? createMemoryRepositories() : createFileRepositories();
  }
  return cached;
}