// Klaviyo 连接配置。
//
// 本期按自用 OPS 场景使用服务端 Private API Key：私钥只从环境变量读取，
// 不放进 NEXT_PUBLIC_*、HTML、localStorage 或可下载的 JSON，也不通过设置页录入。

export type KlaviyoConfig = {
  apiKey: string;
  revision: string;
  writesEnabled: boolean;
  baseUrl: string;
};

export const DEFAULT_REVISION = '2026-07-15';
const BASE_URL = 'https://a.klaviyo.com';

export function apiRevision(): string {
  return process.env.KLAVIYO_API_REVISION?.trim() || DEFAULT_REVISION;
}

export function writesEnabledByEnv(): boolean {
  return process.env.KLAVIYO_ENABLE_WRITES === 'true';
}

export function hasKlaviyoKey(): boolean {
  return Boolean(process.env.KLAVIYO_PRIVATE_API_KEY?.trim());
}

/** 未配置私钥时返回 null —— 模板设计与模拟流程仍然可用 */
export function klaviyoConfig(): KlaviyoConfig | null {
  const apiKey = process.env.KLAVIYO_PRIVATE_API_KEY?.trim();
  if (!apiKey) return null;
  return { apiKey, revision: apiRevision(), writesEnabled: writesEnabledByEnv(), baseUrl: BASE_URL };
}

export function maskKey(key: string): string {
  if (!key) return '';
  return key.length <= 8 ? '••••••' : '••••••' + key.slice(-4);
}

/** 状态接口展示用的脱敏提示 */
export function keyMaskFromEnv(): string {
  const key = process.env.KLAVIYO_PRIVATE_API_KEY?.trim() ?? '';
  return maskKey(key);
}