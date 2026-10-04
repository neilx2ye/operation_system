import { NextResponse, type NextRequest } from 'next/server';
import { allProductRows, parseRange } from '@/lib/mock';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const range = await parseRange(sp.get('from'), sp.get('to'));
  return NextResponse.json(await allProductRows(range));
}