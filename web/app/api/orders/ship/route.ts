import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { orderDetail } from '@/lib/mock';
import { createYuntuOrder, yuntuConfig } from '@/lib/yuntu';
import { pushTrackingToShopify, shopifyConfig } from '@/lib/shopifyFulfill';
import { yuntuReady, shopifyReady, loadSettings } from '@/lib/settings';
import { validateManual, type ManualOrder } from '@/lib/shipTypes';

export const dynamic = 'force-dynamic';

type Shipment = {
  orderId: string;
  waybillNumber: string;
  trackingNumber: string;
  yuntuAt: string;
  shopifyAt: string | null;
  shopifyFulfillmentId: string | null;
  shopifyError: string | null;
  dryRun: boolean;
  manual?: boolean;
  shopifySkipped?: boolean;
};

const FILE = path.join(process.cwd(), 'data', 'shipments.json');

async function load(): Promise<Record<string, Shipment>> {
  try {
    return JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function save(all: Record<string, Shipment>) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(all, null, 2));
}

const norm = (id: string) => (id.startsWith('#') ? id : '#' + id);

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('id');
  const all = await load();
  const ready = { yuntu: yuntuReady(), shopify: shopifyReady() };
  const y = loadSettings().yuntu;
  const defaults = { channelCode: y.channelCode, unitWeightKg: Number(y.unitWeightKg) || 0.3 };
  if (id) return NextResponse.json({ shipment: all[norm(id)] ?? null, ready, defaults });
  return NextResponse.json({ shipments: all, ready });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { id?: string; notifyCustomer?: boolean; retryShopifyOnly?: boolean; manual?: ManualOrder };
  if (!body.id) return NextResponse.json({ error: '缺少订单号' }, { status: 400 });
  const id = norm(body.id);
  const detail = orderDetail(id);
  if (!detail) return NextResponse.json({ error: '订单不存在' }, { status: 404 });
  if (detail.status === '已退款') return NextResponse.json({ error: '订单已全额退款,不能发货' }, { status: 409 });

  if (body.manual) {
    const bad = validateManual(body.manual);
    if (bad) return NextResponse.json({ error: bad }, { status: 400 });
  }

  const all = await load();
  let rec = all[id];
  const ycfg = yuntuConfig();
  const scfg = shopifyConfig();
  const dryRun = !ycfg;

  // 幂等: 已在云途建过单的订单不再重复创建,只允许重试同步 Shopify
  if (rec && !body.retryShopifyOnly) {
    return NextResponse.json({ error: '该订单已创建云途运单', shipment: rec }, { status: 409 });
  }

  try {
    if (!rec) {
      if (ycfg) {
        const r = await createYuntuOrder(detail, ycfg, body.manual);
        rec = { orderId: id, waybillNumber: r.waybillNumber, trackingNumber: r.trackingNumber, yuntuAt: new Date().toISOString(), shopifyAt: null, shopifyFulfillmentId: null, shopifyError: null, dryRun: false, manual: !!body.manual, shopifySkipped: body.manual ? !body.manual.syncShopify : false };
      } else {
        const fake = 'DRY' + id.replace('#', '') + Date.now().toString().slice(-6);
        rec = { orderId: id, waybillNumber: fake, trackingNumber: fake, yuntuAt: new Date().toISOString(), shopifyAt: null, shopifyFulfillmentId: null, shopifyError: null, dryRun: true, manual: !!body.manual, shopifySkipped: body.manual ? !body.manual.syncShopify : false };
      }
      all[id] = rec;
      await save(all);
    }
  } catch (e: any) {
    return NextResponse.json({ error: e.message || String(e) }, { status: 502 });
  }

  if (body.retryShopifyOnly) rec.shopifySkipped = false;
  const notify = body.manual ? body.manual.notifyCustomer : body.notifyCustomer;

  if (rec.shopifySkipped) {
    all[id] = rec;
    await save(all);
  } else if (!rec.dryRun && scfg && !rec.shopifyAt) {
    try {
      const f = await pushTrackingToShopify(scfg, id, rec.trackingNumber, !!notify);
      rec.shopifyAt = new Date().toISOString();
      rec.shopifyFulfillmentId = f.id;
      rec.shopifyError = null;
    } catch (e: any) {
      rec.shopifyError = e.message || String(e);
    }
    all[id] = rec;
    await save(all);
  } else if (!rec.dryRun && !scfg) {
    rec.shopifyError = '未配置 SHOPIFY_SHOP / SHOPIFY_ADMIN_TOKEN';
    all[id] = rec;
    await save(all);
  }

  return NextResponse.json({ shipment: rec, dryRun });
}
