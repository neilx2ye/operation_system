import crypto from 'node:crypto';

// OPS 操作员访问边界。
//
// 现状：OPS 源码里没有可直接复用的完整操作员认证。真实私钥后的写接口不能直接暴露在公网，
// 因此这里给出三种受控身份来源，且默认只信任「本机 + 显式令牌 + 已配置的可信上游」：
//   1. OPS_OPERATOR_TOKEN     —— 自动化/脚本用的共享令牌
//   2. OPS_TRUSTED_PROXY + OPS_OPERATOR_HEADER —— 由可信网关注入的身份头
//   3. 受控本机访问（受 OPS_LOCAL_OPERATOR=false 关闭）
// 浏览器自行传入的用户 ID 一律不采信。

export type OperatorVia = 'local' | 'token' | 'trusted-header';

export type OperatorCheck =
  | { ok: true; subject: string; via: OperatorVia; note: string }
  | { ok: false; code: 'unauthorized' | 'forbidden'; reason: string };

const LOOPBACK_RE = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|\[::1\]|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;

function clientIp(req: Request): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  const real = req.headers.get('x-real-ip');
  return real ? real.trim() : null;
}

function hostIsLocal(req: Request): boolean {
  const host = (req.headers.get('host') ?? '').replace(/:\d+$/, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

export function localOperatorAllowed(): boolean {
  return process.env.OPS_LOCAL_OPERATOR !== 'false';
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function proxyAllowed(ip: string, configured: string): boolean {
  return configured
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .some((entry) => entry === ip || (entry.endsWith('*') && ip.startsWith(entry.slice(0, -1))));
}

export function operatorCheck(req: Request): OperatorCheck {
  const token = process.env.OPS_OPERATOR_TOKEN;
  if (token) {
    const presented = req.headers.get('x-ops-operator-token') ?? '';
    if (presented && safeEqual(presented, token)) {
      return { ok: true, subject: 'token', via: 'token', note: '共享令牌' };
    }
  }

  const proxy = process.env.OPS_TRUSTED_PROXY;
  const headerName = process.env.OPS_OPERATOR_HEADER;
  if (proxy && headerName) {
    const ip = clientIp(req);
    if (ip && proxyAllowed(ip, proxy)) {
      const subject = (req.headers.get(headerName) ?? '').trim();
      if (subject) return { ok: true, subject: subject.slice(0, 120), via: 'trusted-header', note: `可信上游 ${ip} 注入的身份` };
      return { ok: false, code: 'unauthorized', reason: `可信上游请求缺少身份头 ${headerName}` };
    }
  }

  const ip = clientIp(req);
  const fromLocal = ip ? LOOPBACK_RE.test(ip) : hostIsLocal(req);
  if (localOperatorAllowed() && fromLocal) {
    return {
      ok: true,
      subject: 'local',
      via: 'local',
      note: '本机访问。多人或公网部署前必须接入 OPS 统一身份或可信访问网关，否则不得开启真实写入。',
    };
  }

  return {
    ok: false,
    code: 'unauthorized',
    reason: '未验证的操作员身份：真实 Klaviyo 写入只允许本机、已配置的可信上游网关或显式令牌',
  };
}

export type OriginCheck = { ok: true } | { ok: false; reason: string };

/** 浏览器发出的跨站写请求一定带 Origin；这里拒绝与 Host 不一致的来源 */
export function originCheck(req: Request): OriginCheck {
  const origin = req.headers.get('origin');
  if (!origin) return { ok: true };
  if (origin === 'null') return { ok: false, reason: 'Origin 为 null（沙箱或本地文件页面），已拒绝写入' };
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return { ok: false, reason: 'Origin 无法解析' };
  }
  const reqHost = (req.headers.get('host') ?? '').toLowerCase();
  const allowed = (process.env.OPS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (reqHost && host === reqHost) return { ok: true };
  if (allowed.includes(host)) return { ok: true };
  return { ok: false, reason: `Origin ${host} 与请求 Host ${reqHost || '未知'} 不一致` };
}

export function requireOpsAccess(req: Request, opts: { write: boolean }): OperatorCheck {
  const op = operatorCheck(req);
  if (!op.ok) return op;
  if (opts.write) {
    const oc = originCheck(req);
    if (!oc.ok) return { ok: false, code: 'forbidden', reason: oc.reason };
  }
  return op;
}

/** 状态接口用的脱敏视图：不泄露令牌或网关配置内容 */
export function accessSummary(req: Request) {
  const op = operatorCheck(req);
  return {
    operatorVerified: op.ok,
    via: op.ok ? op.via : null,
    subject: op.ok ? op.subject : null,
    note: op.ok ? op.note : op.reason,
    localOperatorAllowed: localOperatorAllowed(),
    trustedProxyConfigured: Boolean(process.env.OPS_TRUSTED_PROXY && process.env.OPS_OPERATOR_HEADER),
    tokenConfigured: Boolean(process.env.OPS_OPERATOR_TOKEN),
    originsAllowlisted: (process.env.OPS_ALLOWED_ORIGINS ?? '').split(',').filter((s) => s.trim()).length,
  };
}