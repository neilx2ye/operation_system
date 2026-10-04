import { storageBackend } from '@/lib/db/pool';
import { createFileRepositories } from './file';
import { createMemoryRepositories } from './memory';
import { createPostgresRepositories } from './postgres';
import type { Repositories } from './types';

// 存储入口：进程内只创建一个实例，页面与路由通过 service.ts 间接使用。
// 后端由 OPS_STORAGE 决定（默认 postgres），旧变量 OPS_EDM_MEMORY_STORE=1 仍可用。

export * from './types';

let cached: Repositories | null = null;

export function getRepositories(): Repositories {
  if (!cached) {
    if (process.env.OPS_EDM_MEMORY_STORE === '1') {
      cached = createMemoryRepositories();
    } else {
      const backend = storageBackend();
      cached = backend === 'memory' ? createMemoryRepositories() : backend === 'file' ? createFileRepositories() : createPostgresRepositories();
    }
  }
  return cached;
}

/** 仅供测试：清空缓存的后端实例。 */
export function resetRepositories(): void {
  cached = null;
}
