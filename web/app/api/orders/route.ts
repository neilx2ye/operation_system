import { NextResponse } from 'next/server';
import { allOrderRows, orderDetail } from '@/lib/mock';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('id');
  if (id) {
    const detail = orderDetail(id.startsWith('#') ? id : '#' + id);
    if (!detail) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(detail);
  }
  return NextResponse.json(allOrderRows());
}
