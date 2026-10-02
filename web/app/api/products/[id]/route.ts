import { NextResponse, type NextRequest } from 'next/server';
import { parseRange, productDetail } from '@/lib/mock';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const sp = req.nextUrl.searchParams;
  const detail = productDetail(id, parseRange(sp.get('from'), sp.get('to')));
  if (!detail) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(detail);
}