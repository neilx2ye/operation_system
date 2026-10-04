import fs from 'node:fs';
import path from 'node:path';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

// 数据库底座：连接池、一次性建表、事务封装。
//
// 后端由 OPS_STORAGE 选择：
//   postgres(默认) —— 业务数据落在 PostgreSQL
//   file           —— 旧的文件实现（回滚用）
//   memory         —— 进程内存（测试用）
// 测试脚本会显式设置 OPS_STORAGE=memory 或 file，不受默认值影响。

export type StorageBackend = 'postgres' | 'file' | 'memory';

export function storageBackend(): StorageBackend {
  const v = (process.env.OPS_STORAGE ?? '').trim().toLowerCase();
  if (v === 'file') return 'file';
  if (v === 'memory') return 'memory';
  return 'postgres';
}

export function databaseConfigured(): boolean {
  return Boolean(
    process.env.DATABASE_URL?.trim() ||
      process.env.PGHOST ||
      process.env.PGPASSWORD ||
      process.env.PGDATABASE,
  );
}

const POOL_KEY = Symbol.for('ops.db.pool');
const SCHEMA_KEY = Symbol.for('ops.db.schema');
type PoolGlobal = typeof globalThis & { [POOL_KEY]?: Pool; [SCHEMA_KEY]?: Promise<void> };

/** 连接池单例；HMR 重新执行模块时复用 globalThis 上的实例，避免连接泄漏。 */
export function getPool(): Pool {
  const g = globalThis as PoolGlobal;
  if (!g[POOL_KEY]) {
    const url = process.env.DATABASE_URL?.trim();
    g[POOL_KEY] = url
      ? new Pool({ connectionString: url, max: Number(process.env.PGPOOL_MAX) || 10 })
      : new Pool({ max: Number(process.env.PGPOOL_MAX) || 10 });
    // 空闲连接出错不应让进程崩溃
    g[POOL_KEY]!.on('error', (err) => {
      console.error('[db] idle client error:', err.message);
    });
  }
  return g[POOL_KEY]!;
}

/**
 * 首次访问时建立表结构，之后复用同一个 Promise。
 * schema.sql 与仓库源码同目录；cwd 即 web/（next dev / next start / 迁移脚本都在此运行）。
 */
export function ensureSchema(): Promise<void> {
  const g = globalThis as PoolGlobal;
  g[SCHEMA_KEY] ??= (async () => {
    const file = path.join(process.cwd(), 'lib', 'db', 'schema.sql');
    const sql = fs.readFileSync(file, 'utf8');
    await getPool().query(sql);
  })();
  return g[SCHEMA_KEY]!.catch((e) => {
    // 失败不缓存：下次访问重试，避免一次瞬时故障永久毒化进程
    g[SCHEMA_KEY] = undefined;
    throw e;
  });
}

export async function dbQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  await ensureSchema();
  return getPool().query<T>(text, params as never[]);
}

export async function dbRows<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await dbQuery<T>(text, params)).rows;
}

export async function dbOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await dbRows<T>(text, params);
  return rows.length ? rows[0] : null;
}

/** 事务：回调内的所有语句要么一起提交，要么一起回滚。 */
export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* 回滚失败时不掩盖原始错误 */
    }
    throw e;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  const g = globalThis as PoolGlobal;
  const pool = g[POOL_KEY];
  if (pool) {
    await pool.end();
    g[POOL_KEY] = undefined;
  }
}
