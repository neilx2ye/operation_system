import { ASSET_MIME, type AssetMime, type LintIssue, type LintResult } from './types';

// 邮件 HTML 的通用处理：素材引用解析、Klaviyo 语法保护、发布前检查。
// 只做字符串级处理，不引入 DOM 依赖，保证服务端与浏览器行为一致。

export const MAX_HTML_BYTES = 1024 * 1024;

/** 服务端与浏览器都要用，因此不依赖 Node 的 Buffer */
function byteLength(text: string): number {
  return typeof Buffer !== 'undefined' ? Buffer.byteLength(text) : new TextEncoder().encode(text).length;
}

/** 本地素材在设计稿里的引用形式 */
export const LOCAL_ASSET_PREFIX = '/api/edm/assets/';

const LOCAL_ASSET_RE = new RegExp(LOCAL_ASSET_PREFIX.replace(/[/]/g, '\\/') + '([A-Za-z0-9][A-Za-z0-9_-]{0,63})', 'g');

export function extractLocalAssetIds(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(LOCAL_ASSET_RE)) out.add(m[1]);
  return [...out];
}

export function replaceLocalAssetIds(html: string, mapping: Record<string, string>): string {
  return html.replace(LOCAL_ASSET_RE, (whole, id: string) => mapping[id] ?? whole);
}

/** 明确不允许出现在邮件里的地址形态 */
export type UnsafeUrlReason = 'blob' | 'data' | 'localhost' | 'private_host' | 'file' | 'insecure';

const PRIVATE_HOST_RE =
  /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|.*\.local$|.*\.internal$)/i;

export function checkImageUrl(url: string): UnsafeUrlReason | null {
  const raw = url.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.startsWith('blob:')) return 'blob';
  if (lower.startsWith('data:')) return 'data';
  if (lower.startsWith('file:')) return 'file';
  if (!/^https?:\/\//i.test(raw)) return 'insecure';
  let host: string;
  let proto: string;
  try {
    const u = new URL(raw);
    host = u.hostname;
    proto = u.protocol;
  } catch {
    return 'insecure';
  }
  if (proto !== 'https:') return 'insecure';
  if (PRIVATE_HOST_RE.test(host)) return 'private_host';
  return null;
}

export function extractImageUrls(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const v = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (v) out.add(v);
  }
  // 背景图与 CSS url() 同样会被邮件客户端加载
  for (const m of html.matchAll(/url\(\s*("([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
    const v = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (v && !v.startsWith('cid:')) out.add(v);
  }
  return [...out];
}

/** 退订入口：Klaviyo 自定义 HTML 模板官方要求保留退订标签 */
const UNSUBSCRIBE_RES = [
  /\{%-?\s*unsubscribe[^%]*%\}/i,
  /\{\{-?\s*unsubscribe[^}]*\}\}/i,
  /unsubscribe_url|unsubscribe_link|unsubscribe\s*%\}/i,
  /href\s*=\s*("[^"]*unsubscribe[^"]*"|'[^']*unsubscribe[^']*')/i,
  />\s*[^<]{0,40}unsubscribe[^<]{0,40}</i,
  /[^<]{0,20}退订[^<]{0,20}/,
];

export function hasUnsubscribeEntry(html: string): boolean {
  return UNSUBSCRIBE_RES.some((re) => re.test(html));
}

/** Klaviyo 模板变量/标签 */
export function countKlaviyoTokens(html: string): { variables: number; tags: number } {
  const variables = [...html.matchAll(/\{\{[^}]*\}\}/g)].length;
  const tags = [...html.matchAll(/\{%[^%]*%\}/g)].length;
  return { variables, tags };
}

function countOccurrences(html: string, re: RegExp): number {
  return [...html.matchAll(re)].length;
}

/**
 * 发布前检查。errors 会阻断同步，warnings 只提示。
 * @param html 待发布 HTML
 * @param opts.unresolvedAssets 仍未解析成本地/公开地址的素材 ID
 */
export function lintEmailHtml(html: string, opts: { unresolvedAssets?: string[]; knownAssetIds?: string[] } = {}): LintResult {
  const issues: LintIssue[] = [];
  const push = (level: LintIssue['level'], rule: string, message: string) => issues.push({ level, rule, message });

  if (byteLength(html) > MAX_HTML_BYTES) {
    push('error', 'size', `HTML 超过 ${Math.round(MAX_HTML_BYTES / 1024)} KB 上限`);
  }
  if (!html.trim()) push('error', 'empty', '模板内容为空');

  if (!/<html[\s>]/i.test(html)) push('warn', 'document', '缺少 <html> 根标签，部分客户端可能无法正确渲染');
  if (!/<body[\s>]/i.test(html)) push('warn', 'document', '缺少 <body> 标签');

  if (!hasUnsubscribeEntry(html)) {
    push('error', 'unsubscribe', '缺少退订入口：Klaviyo 自定义 HTML 模板要求保留退订标签');
  }

  const msoOpen = countOccurrences(html, /<!--\s*\[if\b/gi);
  const msoClose = countOccurrences(html, /<!\[endif\]\s*-->/gi);
  if (msoOpen !== msoClose) {
    push('warn', 'mso', `MSO 条件注释不配对（开 ${msoOpen} / 闭 ${msoClose}），Outlook 可能渲染异常`);
  }

  const { variables, tags } = countKlaviyoTokens(html);
  const known = new Set(opts.knownAssetIds ?? []);
  const localRefs = extractLocalAssetIds(html).filter((id) => !known.has(id));
  if (localRefs.length) {
    push('error', 'asset_unknown', `引用了不存在的本地素材：${localRefs.join(', ')}`);
  }
  if (opts.unresolvedAssets?.length) {
    push('error', 'asset_unresolved', `以下素材尚未上传到 Klaviyo：${opts.unresolvedAssets.join(', ')}`);
  }

  for (const url of extractImageUrls(html)) {
    if (url.startsWith(LOCAL_ASSET_PREFIX)) continue;
    const reason = checkImageUrl(url);
    if (!reason) continue;
    const label =
      reason === 'blob'
        ? 'blob: 临时地址'
        : reason === 'data'
          ? 'data: 内联地址'
          : reason === 'file'
            ? '本地文件路径'
            : reason === 'insecure'
              ? '不是公开 HTTPS 地址'
              : '指向内网/本机地址';
    // 未发布的本地素材允许留在草稿里，因此只对「推送」阶段报错
    push(reason === 'private_host' || reason === 'insecure' ? 'error' : 'warn', 'image_url', `图片地址不可用于邮件（${label}）：${url.slice(0, 120)}`);
  }

  if (variables === 0 && tags === 0) {
    push('warn', 'klaviyo', '未发现 {{ }} 或 {% %} 模板语法，确认这不是需要个性化的模板');
  }

  if (/(src|href)\s*=\s*("javascript:|'javascript:)/i.test(html)) {
    push('error', 'script_url', '存在 javascript: 伪协议链接');
  }
  if (/<script\b/i.test(html)) {
    push('warn', 'script', '模板含 <script>，OPS 预览会以沙箱方式隔离执行；邮件客户端通常会忽略');
  }

  return { ok: !issues.some((i) => i.level === 'error'), issues };
}

export function normalizeAssetMime(mime: string): AssetMime | null {
  const v = mime.trim().toLowerCase();
  if (v === 'image/jpg') return 'image/jpeg';
  return (ASSET_MIME as readonly string[]).includes(v) ? (v as AssetMime) : null;
}

export function extForMime(mime: AssetMime): string {
  return mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'gif';
}