import { NextResponse } from 'next/server';
import { loadSettings, saveSettings, maskSecret, yuntuReady, shopifyReady, type Settings } from '@/lib/settings';
import { shopifyConfig, testShopify } from '@/lib/shopifyFulfill';
import { getBinding, updateBinding } from '@/lib/edm/service';
import { apiRevision, hasKlaviyoKey, keyMaskFromEnv, klaviyoConfig, writesEnabledByEnv } from '@/lib/integrations/klaviyo/config';
import { testConnection } from '@/lib/integrations/klaviyo/accounts';
import { accessSummary, requireOpsAccess } from '@/lib/ops-access';

export const dynamic = 'force-dynamic';

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/**
 * Klaviyo 卡片只展示非敏感绑定信息；私钥来自 KLAVIYO_PRIVATE_API_KEY 环境变量，
 * 不经由设置页录入，也永远不会回显到浏览器。
 */
function view(req?: Request) {
  const s = loadSettings();
  const binding = getBinding();
  const envWrites = writesEnabledByEnv();
  const access = req ? accessSummary(req) : null;
  return {
    yuntu: { ...s.yuntu, apiSecret: '', apiSecretMask: maskSecret(s.yuntu.apiSecret) },
    shopify: { ...s.shopify, adminToken: '', adminTokenMask: maskSecret(s.shopify.adminToken) },
    klaviyo: {
      accountId: binding.accountId,
      accountLabel: binding.accountLabel,
      storeKey: binding.storeKey,
      apiRevision: binding.apiRevision || apiRevision(),
      defaultListId: binding.defaultListId,
      defaultListName: binding.defaultListName,
      writesEnabled: binding.writesEnabled,
      lastCheck: binding.lastCheck,
      lastCheckedAt: binding.lastCheckedAt,
      configured: hasKlaviyoKey(),
      keyMask: keyMaskFromEnv(),
      keySource: 'KLAVIYO_PRIVATE_API_KEY(环境变量)',
      writesEnabledByEnv: envWrites,
      writesReady: envWrites && binding.writesEnabled && Boolean(access?.operatorVerified),
      access,
    },
    ready: { yuntu: yuntuReady(s), shopify: shopifyReady(s), klaviyo: hasKlaviyoKey() },
  };
}

export async function GET(req: Request) {
  return NextResponse.json(view(req));
}

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

  // Klaviyo 的非敏感绑定走 EDM 数据目录，与私钥(环境变量)分开保存。
  // 先把补丁和它的校验都算完，再落盘：被拒绝的请求不能留下半次写入。
  const patch: Record<string, unknown> = {};
  if (b.klaviyo && typeof b.klaviyo === 'object') {
    const k = b.klaviyo;
    if ('accountLabel' in k) patch.accountLabel = str(k.accountLabel).slice(0, 120);
    if ('storeKey' in k) patch.storeKey = str(k.storeKey).slice(0, 64);
    if ('apiRevision' in k) {
      const rev = str(k.apiRevision);
      if (rev && !/^\d{4}-\d{2}-\d{2}$/.test(rev)) return NextResponse.json({ error: 'API revision 需要形如 2026-07-15' }, { status: 400 });
      patch.apiRevision = rev || apiRevision();
    }
    if ('defaultListId' in k) patch.defaultListId = str(k.defaultListId) || null;
    if ('defaultListName' in k) patch.defaultListName = str(k.defaultListName).slice(0, 120);
    if ('writesEnabled' in k) patch.writesEnabled = k.writesEnabled === true;
  }

  saveSettings(next);
  if (Object.keys(patch).length) updateBinding(patch);

  return NextResponse.json(view(req));
}

// 测试连接：Shopify 直接调用；云途没有官方确认的无副作用接口，不做猜测
export async function POST(req: Request) {
  const b: any = await req.json().catch(() => ({}));

  if (b.target === 'klaviyo') {
    const op = requireOpsAccess(req, { write: false });
    if (!op.ok) {
      return NextResponse.json({ ok: false, error: op.reason, code: op.code }, { status: op.code === 'unauthorized' ? 401 : 403 });
    }
    if (!klaviyoConfig()) {
      return NextResponse.json({ ok: false, error: '未配置 KLAVIYO_PRIVATE_API_KEY 环境变量' }, { status: 400 });
    }
    try {
      const r = await testConnection();
      updateBinding({
        lastCheckedAt: new Date().toISOString(),
        lastCheck: { ok: r.ok, detail: r.detail },
        ...(r.account ? { accountId: r.account.id, accountLabel: r.account.label } : {}),
      });
      return NextResponse.json(r);
    } catch (e: any) {
      const detail = (e?.message || String(e)).slice(0, 300);
      updateBinding({ lastCheckedAt: new Date().toISOString(), lastCheck: { ok: false, detail } });
      return NextResponse.json({ ok: false, error: detail }, { status: 502 });
    }
  }

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
