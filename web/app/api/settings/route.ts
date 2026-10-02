import { NextResponse } from 'next/server';
import { loadSettings, saveSettings, maskSecret, yuntuReady, shopifyReady, type Settings } from '@/lib/settings';
import { shopifyConfig, testShopify } from '@/lib/shopifyFulfill';

export const dynamic = 'force-dynamic';

function view() {
  const s = loadSettings();
  return {
    yuntu: { ...s.yuntu, apiSecret: '', apiSecretMask: maskSecret(s.yuntu.apiSecret) },
    shopify: { ...s.shopify, adminToken: '', adminTokenMask: maskSecret(s.shopify.adminToken) },
    ready: { yuntu: yuntuReady(s), shopify: shopifyReady(s) },
  };
}

export async function GET() {
  return NextResponse.json(view());
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

// 密钥字段留空 = 保持原值
export async function PUT(req: Request) {
  const b: any = await req.json().catch(() => null);
  if (!b) return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  const cur = loadSettings();
  const next: Settings = {
    yuntu: {
      baseUrl: str(b.yuntu?.baseUrl),
      customerCode: str(b.yuntu?.customerCode),
      apiSecret: str(b.yuntu?.apiSecret) || cur.yuntu.apiSecret,
      channelCode: str(b.yuntu?.channelCode),
      unitWeightKg: str(b.yuntu?.unitWeightKg) || '0.3',
    },
    shopify: {
      shop: str(b.shopify?.shop),
      adminToken: str(b.shopify?.adminToken) || cur.shopify.adminToken,
      apiVersion: str(b.shopify?.apiVersion) || '2025-07',
    },
  };
  if (next.yuntu.baseUrl && !/^https?:\/\//.test(next.yuntu.baseUrl)) return NextResponse.json({ error: '云途接口域名需以 http:// 或 https:// 开头' }, { status: 400 });
  if (!(Number(next.yuntu.unitWeightKg) > 0)) return NextResponse.json({ error: '默认单件重量必须大于 0' }, { status: 400 });
  saveSettings(next);
  return NextResponse.json(view());
}

// 测试连接(目前仅 Shopify:云途没有官方确认的无副作用接口,不做猜测)
export async function POST(req: Request) {
  const b: any = await req.json().catch(() => ({}));
  if (b.target !== 'shopify') return NextResponse.json({ error: '不支持的测试目标' }, { status: 400 });
  const cfg = shopifyConfig();
  if (!cfg) return NextResponse.json({ error: '请先保存 Shopify 店铺域名和 Admin Token' }, { status: 400 });
  try {
    const r = await testShopify(cfg);
    const need = ['read_orders', 'read_merchant_managed_fulfillment_orders', 'write_merchant_managed_fulfillment_orders'];
    return NextResponse.json({ ok: true, ...r, missingScopes: need.filter((n) => !r.scopes.includes(n)) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message || String(e) }, { status: 502 });
  }
}
