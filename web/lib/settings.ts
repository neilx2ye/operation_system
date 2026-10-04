import { readSettingsDoc, writeSettingsDoc } from '@/lib/db/docs';

// 接口配置存储（PostgreSQL 单行文档表 ops_settings；file 后端回落到 data/settings.json）。
// 仅服务端使用，密钥不会原样返回前端。
// 优先级: 设置页保存的值 > 环境变量。

export type Settings = {
  yuntu: { baseUrl: string; customerCode: string; apiSecret: string; channelCode: string; unitWeightKg: string };
  shopify: { shop: string; adminToken: string; apiVersion: string };
};

export const SECRET_FIELDS = ['yuntu.apiSecret', 'shopify.adminToken'] as const;

function fromEnv(): Settings {
  const e = process.env;
  return {
    yuntu: {
      baseUrl: e.YUNTU_BASE_URL || '',
      customerCode: e.YUNTU_CUSTOMER_CODE || '',
      apiSecret: e.YUNTU_API_SECRET || '',
      channelCode: e.YUNTU_CHANNEL_CODE || '',
      unitWeightKg: e.YUNTU_DEFAULT_UNIT_WEIGHT_KG || '0.3',
    },
    shopify: { shop: e.SHOPIFY_SHOP || '', adminToken: e.SHOPIFY_ADMIN_TOKEN || '', apiVersion: e.SHOPIFY_API_VERSION || '2025-07' },
  };
}

export async function loadSettings(): Promise<Settings> {
  const base = fromEnv();
  let saved: Partial<Settings> = {};
  const doc = await readSettingsDoc();
  if (doc && typeof doc === 'object') saved = doc as Partial<Settings>;
  const pick = <T extends Record<string, string>>(a: T, b?: Partial<T>): T => {
    const out = { ...a };
    for (const k of Object.keys(a)) {
      const v = b?.[k];
      if (typeof v === 'string' && v !== '') (out as Record<string, string>)[k] = v;
    }
    return out;
  };
  return { yuntu: pick(base.yuntu, saved.yuntu), shopify: pick(base.shopify, saved.shopify) };
}

export async function saveSettings(s: Settings): Promise<void> {
  await writeSettingsDoc(s);
}

export function maskSecret(v: string) {
  if (!v) return '';
  return v.length <= 6 ? '••••••' : '••••••' + v.slice(-3);
}

export function yuntuReady(s: Settings) {
  const y = s.yuntu;
  return !!(y.baseUrl && y.customerCode && y.apiSecret && y.channelCode);
}

export function shopifyReady(s: Settings) {
  return !!(s.shopify.shop && s.shopify.adminToken);
}
