import { ServiceError } from '@/lib/edm/http';
import type { ApiErrorCode } from '@/lib/edm/types';
import { klaviyoConfig, type KlaviyoConfig } from './config';

// 统一的 Klaviyo 服务端请求器。
//
// 约定：
//  - 私钥只出现在请求头里，绝不进入错误信息、日志或响应。
//  - 读取（GET）可以安全重试；写入超时/5xx 的结果可能不明，标记 outcome='unknown'，
//    由调用方先核对远端或交人工处理，不盲目重发造成重复。
//  - 429 按 Retry-After 等待并限制重试次数，绝不当作成功。

const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 20_000;
const MAX_REMOTE_MESSAGE = 300;

export type KlaviyoOutcome = 'failed' | 'unknown';

export function klaviyoFailure(
  code: ApiErrorCode,
  message: string,
  status: number,
  retryable: boolean,
  outcome: KlaviyoOutcome,
  remoteCode?: string | null,
): ServiceError {
  return new ServiceError(code, message, status, retryable, { outcome, ...(remoteCode ? { remoteCode } : {}) });
}

export function outcomeOf(e: unknown): KlaviyoOutcome {
  if (e instanceof ServiceError && e.extra?.outcome === 'unknown') return 'unknown';
  return 'failed';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function backoffMs(attempt: number): number {
  return Math.round(500 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
}

export type QueryValue = string | number | string[] | number[] | undefined;

export function buildUrl(baseUrl: string, path: string, query?: Record<string, QueryValue>): string {
  if (/^https?:\/\//i.test(path)) return path;
  const url = new URL(baseUrl.replace(/\/$/, '') + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, String(v)));
      else url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function headers(cfg: KlaviyoConfig, withBody: boolean): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Klaviyo-API-Key ${cfg.apiKey}`,
    revision: cfg.revision,
    accept: 'application/vnd.api+json',
  };
  if (withBody) h['content-type'] = 'application/json';
  return h;
}

/** 从 Klaviyo 错误信封里取一条可读信息，绝不回传完整响应体 */
function parseRemoteError(text: string): { message: string; code: string | null } {
  const fallback = { message: '远端未提供详细信息', code: null as string | null };
  if (!text.trim()) return fallback;
  try {
    const body = JSON.parse(text) as { errors?: { code?: string; title?: string; detail?: string; status?: string }[] };
    const first = body.errors?.[0];
    if (!first) return fallback;
    const message = (first.detail || first.title || first.code || fallback.message).replace(/\s+/g, ' ').slice(0, MAX_REMOTE_MESSAGE);
    return { message, code: first.code ?? null };
  } catch {
    return fallback;
  }
}

function retryAfterMs(res: Response, attempt: number): number {
  const raw = res.headers.get('retry-after');
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
    const date = Date.parse(raw);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_WAIT_MS);
  }
  return Math.min(backoffMs(attempt) * 2, MAX_RETRY_WAIT_MS);
}

export type KlaviyoRequest = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** 与 body 互斥：图片上传等 multipart 请求，边界由 fetch 自己生成 */
  formData?: FormData;
  /** 缺省按 method 判断：GET 可重试，写入不可 */
  idempotent?: boolean;
  timeoutMs?: number;
};

export async function klaviyoFetch<T = unknown>(req: KlaviyoRequest, cfg: KlaviyoConfig | null = klaviyoConfig()): Promise<T> {
  if (!cfg) throw klaviyoFailure('unavailable', '未配置 KLAVIYO_PRIVATE_API_KEY，无法访问 Klaviyo', 503, false, 'failed');

  const method = req.method ?? 'GET';
  const idempotent = req.idempotent ?? method === 'GET';
  const url = buildUrl(cfg.baseUrl, req.path, req.query);
  // multipart 的 content-type 必须由 fetch 连同 boundary 一起生成，不能自己写
  const body: BodyInit | undefined = req.formData
    ? (req.formData as unknown as BodyInit)
    : req.body === undefined
      ? undefined
      : JSON.stringify(req.body);
  const canRetry = () => idempotent;

  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: headers(cfg, body !== undefined && !req.formData),
        body,
        signal: AbortSignal.timeout(req.timeoutMs ?? TIMEOUT_MS),
        cache: 'no-store',
      });
    } catch {
      if (canRetry() && attempt <= MAX_RETRIES) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw klaviyoFailure(
        'upstream',
        idempotent ? '连接 Klaviyo 失败，请检查网络后重试' : '请求 Klaviyo 时连接中断，写入结果不明，请先到 Klaviyo 核对再决定是否重试',
        502,
        true,
        idempotent ? 'failed' : 'unknown',
      );
    }

    const status = res.status;
    const text = await res.text().catch(() => '');

    if (status === 429) {
      if (attempt <= MAX_RETRIES) {
        await sleep(retryAfterMs(res, attempt));
        continue;
      }
      throw klaviyoFailure(
        'rate_limited',
        'Klaviyo 触发限流，请稍后重试',
        429,
        true,
        idempotent ? 'failed' : 'unknown',
      );
    }

    if (status >= 500) {
      if (canRetry() && attempt <= MAX_RETRIES) {
        await sleep(backoffMs(attempt));
        continue;
      }
      const outcome: KlaviyoOutcome = idempotent ? 'failed' : 'unknown';
      throw klaviyoFailure(
        'upstream',
        idempotent ? `Klaviyo 返回 ${status}，请稍后重试` : `Klaviyo 返回 ${status}，写入结果不明，请先到 Klaviyo 核对`,
        502,
        true,
        outcome,
      );
    }

    if (status === 401) {
      throw klaviyoFailure('unauthorized', 'Klaviyo 私钥无效或已被撤销', 401, false, 'failed');
    }

    if (status === 403) {
      const remote = parseRemoteError(text);
      throw klaviyoFailure('forbidden', `Klaviyo 拒绝了该请求（权限不足）：${remote.message}`, 403, false, 'failed', remote.code);
    }

    if (!res.ok) {
      const remote = parseRemoteError(text);
      throw klaviyoFailure(
        'bad_request',
        `Klaviyo 返回 ${status}：${remote.message}`,
        status === 400 || status === 404 ? status : 502,
        false,
        'failed',
        remote.code,
      );
    }

    if (status === 202 || status === 204 || !text.trim()) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw klaviyoFailure('upstream', 'Klaviyo 响应不是合法 JSON', 502, false, 'failed');
    }
  }
}

export type JsonApiResource<T> = { type: string; id: string; attributes: T; relationships?: unknown };

export type KlaviyoPage<T> = { data?: JsonApiResource<T>[]; links?: { next?: string | null } };

/** 跟随 links.next 分页；maxPages 防止一次性拉取过多 */
export async function klaviyoListAll<T>(
  path: string,
  query: Record<string, QueryValue> | undefined,
  pick: (body: KlaviyoPage<T>) => JsonApiResource<T>[],
  opts: { maxPages?: number; cfg?: KlaviyoConfig | null; label?: string } = {},
): Promise<JsonApiResource<T>[]> {
  const maxPages = opts.maxPages ?? 20;
  const out: JsonApiResource<T>[] = [];
  let next: string | null = buildUrl((opts.cfg ?? klaviyoConfig())?.baseUrl ?? 'https://a.klaviyo.com', path, query);
  for (let page = 0; page < maxPages && next; page++) {
    const body: KlaviyoPage<T> = await klaviyoFetch<KlaviyoPage<T>>({ path: next }, opts.cfg ?? klaviyoConfig());
    out.push(...pick(body ?? {}));
    next = body?.links?.next ?? null;
    if (next && page === maxPages - 1) {
      throw klaviyoFailure('unavailable', `${opts.label ?? '查询'}数据过多，已达到分页上限 ${maxPages} 页`, 503, true, 'failed');
    }
  }
  return out;
}