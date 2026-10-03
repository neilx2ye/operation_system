import fs from 'node:fs';
import path from 'node:path';

// 本地文件存储底座：路径解析、原子写入、损坏恢复。
// 仅用于单实例、有持久磁盘的受控部署；多实例并发不在本期范围。
//
// OPS_DATA_DIR 必须是明确路径：一旦工作目录变化，不能把数据写进旧 EDM 目录。

const OLD_EDM_MARKER = 'edm_manager';

export function edmDataDir(): string {
  const base = process.env.OPS_DATA_DIR?.trim();
  const dir = base
    ? path.join(path.resolve(base), 'edm')
    : path.join(process.cwd(), 'data', 'edm');
  const resolved = path.resolve(dir);
  if (resolved.split(path.sep).includes(OLD_EDM_MARKER)) {
    throw new Error(`OPS_DATA_DIR 解析到了旧 EDM 目录，已拒绝写入：${resolved}`);
  }
  return resolved;
}

export const DIRS = {
  templates: 'templates',
  versions: 'versions',
  assets: 'assets',
  audiences: 'audiences',
  preparations: 'preparations',
  operations: 'operations',
} as const;

export type DirKind = keyof typeof DIRS;

export function dirOf(kind: DirKind): string {
  return path.join(edmDataDir(), DIRS[kind]);
}

export function fileOf(kind: DirKind, id: string, ext = 'json'): string {
  return path.join(dirOf(kind), `${id}.${ext}`);
}

/** 单个 JSON 文件的体积上限，防止把任意大文件读进内存 */
export const MAX_JSON_BYTES = 4 * 1024 * 1024;

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function exists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * 读取 JSON。文件不存在返回 fallback；
 * 文件损坏时把损坏内容另存为 .corrupt-<ts> 便于诊断，然后返回 fallback。
 */
export function readJson<T>(file: string, fallback: T): T {
  let raw: string;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return fallback;
    if (st.size > MAX_JSON_BYTES) throw new Error(`文件超过 ${MAX_JSON_BYTES} 字节上限`);
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* 诊断文件写不出去也不能阻断读取 */
    }
    return fallback;
  }
}

/** 读原始文本（HTML 快照用 JSON 保存，此处保留给纯文本场景） */
export function readText(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_JSON_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 临时文件 + rename 的原子写入，避免半截文件 */
export function writeJsonAtomic(file: string, value: unknown) {
  const body = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(body) > MAX_JSON_BYTES) throw new Error(`写入超过 ${MAX_JSON_BYTES} 字节上限`);
  writeFileAtomic(file, body);
}

export function writeFileAtomic(file: string, body: string | Buffer) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, body);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw e;
  }
}

export function removeFile(file: string) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* 已经不存在视为成功 */
  }
}

/** 列出目录下的 JSON 文件对应的 id（去掉扩展名） */
export function listIds(kind: DirKind): string[] {
  const dir = dirOf(kind);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json') && !n.includes('.tmp-') && !n.includes('.corrupt-'))
    .map((n) => n.slice(0, -'.json'.length));
}

/** 目录下非 JSON 的文件名（素材原图用） */
export function listAssetFiles(): string[] {
  const dir = dirOf('assets');
  try {
    return fs.readdirSync(dir).filter((n) => !n.includes('.tmp-'));
  } catch {
    return [];
  }
}

/**
 * 进程内串行化：同一进程里对同一文件的读改写顺序执行。
 * 不解决多实例并发，只保证单实例下的写-写不互相覆盖。
 */
const locks = new Map<string, Promise<unknown>>();

export function withLock<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    key,
    next.catch(() => {}),
  );
  return next;
}