import { NextResponse } from 'next/server';
import type { ApiErrorBody, ApiErrorCode } from './types';

// 统一错误与请求体处理。所有 /api/edm 与 /api/integrations/klaviyo 路由共用，
// 保证错误响应都带 code / message / retryable，且不回传私钥或完整远端响应。

export class ServiceError extends Error {
  code: ApiErrorCode;
  status: number;
  retryable: boolean;
  extra: Record<string, unknown>;

  constructor(code: ApiErrorCode, message: string, status: number, retryable = false, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.extra = extra;
  }
}

export const badRequest = (message: string, extra?: Record<string, unknown>) => new ServiceError('bad_request', message, 400, false, extra);
export const unauthorized = (message: string) => new ServiceError('unauthorized', message, 401);
export const forbidden = (message: string, extra?: Record<string, unknown>) => new ServiceError('forbidden', message, 403, false, extra);
export const notFound = (message: string) => new ServiceError('not_found', message, 404);
export const conflict = (message: string, extra?: Record<string, unknown>) => new ServiceError('conflict', message, 409, false, extra);
export const tooLarge = (message: string) => new ServiceError('too_large', message, 413);
export const unsupported = (message: string) => new ServiceError('unsupported', message, 415);
export const writesDisabled = (message: string) => new ServiceError('writes_disabled', message, 403);
export const upstream = (message: string, retryable = true) => new ServiceError('upstream', message, 502, retryable);
export const unavailable = (message: string, retryable = true) => new ServiceError('unavailable', message, 503, retryable);

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof ServiceError) {
    const body: ApiErrorBody & Record<string, unknown> = {
      code: e.code,
      message: e.message,
      retryable: e.retryable,
      ...e.extra,
    };
    return NextResponse.json(body, { status: e.status });
  }
  const message = e instanceof Error ? e.message : String(e);
  // assertSafeId 等底层校验抛出的是普通 Error，归一成 400 而不是 500
  if (/^非法 ID$/.test(message)) {
    return NextResponse.json({ code: 'bad_request', message: '非法 ID', retryable: false }, { status: 400 });
  }
  return NextResponse.json({ code: 'unavailable', message: message.slice(0, 300), retryable: false }, { status: 500 });
}

export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** 读取 JSON 请求体，带体积上限；空体返回 {} */
export async function readJsonBody<T = Record<string, unknown>>(req: Request, maxBytes = MAX_BODY_BYTES): Promise<T> {
  const text = await req.text();
  if (Buffer.byteLength(text) > maxBytes) throw tooLarge(`请求体超过 ${Math.round(maxBytes / 1024)} KB 上限`);
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw badRequest('请求体不是合法 JSON');
  }
}

export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
export const strOr = (v: unknown, fallback: string): string => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
export const bool = (v: unknown): boolean => v === true;
export const nowIso = () => new Date().toISOString();