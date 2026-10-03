import crypto from 'node:crypto';

// 所有本地 id 都必须是这个形状，才能安全地拼进文件路径。
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const ID_PREFIXES = {
  template: 'tpl',
  version: 'ver',
  asset: 'ast',
  audience: 'aud',
  preparation: 'prep',
  operation: 'op',
  category: 'cat',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function newId(kind: IdKind): string {
  const rand = crypto.randomBytes(6).toString('hex');
  return `${ID_PREFIXES[kind]}_${Date.now().toString(36)}${rand}`;
}

export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

/** 校验 id 前缀，避免把 aud_ 当成 tpl_ 用 */
export function isIdOfKind(id: unknown, kind: IdKind): id is string {
  return isSafeId(id) && id.startsWith(ID_PREFIXES[kind] + '_');
}

/** 非法 id 直接抛出，由路由层转成 400，避免任意文件访问 */
export function assertSafeId(id: unknown, kind?: IdKind): string {
  if (kind ? !isIdOfKind(id, kind) : !isSafeId(id)) throw new Error('非法 ID');
  return id as string;
}

export function sha256(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function shortHash(input: string | Buffer, len = 12): string {
  return sha256(input).slice(0, len);
}