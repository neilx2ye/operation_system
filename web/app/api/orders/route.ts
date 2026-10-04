import { NextResponse } from 'next/server';
import { allOrderRows, orderDetail, type OrderDetail, type OrderRow } from '@/lib/mock';
import { readShipments } from '@/lib/db/docs';

export const dynamic = 'force-dynamic';

type Shipment = {
  orderId: string;
  yuntuAt: string;
  shopifyAt: string | null;
  shopifyError: string | null;
  dryRun: boolean;
  shopifySkipped?: boolean;
};

const norm = (id: string) => (id.startsWith('#') ? id : '#' + id);

async function loadShipments(): Promise<Record<string, Shipment>> {
  return (await readShipments()) as Record<string, Shipment>;
}

function mergeLogistics<T extends OrderRow>(row: T, shipment: Shipment | null): T {
  const fromShopify = row.logisticsStatus || '未发货';
  if (fromShopify !== '未发货') return row;

  let logisticsStatus = fromShopify;
  if (shipment) {
    logisticsStatus = shipment.dryRun
      ? '演示单'
      : shipment.shopifyAt
        ? '已同步追踪号'
        : shipment.shopifyError
          ? '回写失败'
          : shipment.shopifySkipped
            ? '已建单未回写'
            : '已创建运单';
  } else if (row.status === '已退款') {
    logisticsStatus = '无需发货';
  }

  return { ...row, logisticsStatus };
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('id');
  const shipments = await loadShipments();

  if (id) {
    const orderId = norm(id);
    const detail = await orderDetail(orderId);
    if (!detail) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(mergeLogistics(detail as OrderDetail, shipments[orderId] ?? null));
  }

  return NextResponse.json((await allOrderRows()).map((row) => mergeLogistics(row, shipments[norm(row.id)] ?? null)));
}
