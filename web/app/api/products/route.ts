import { NextResponse, type NextRequest } from 'next/server';
import { allProductRows, parseRange } from '@/lib/mock';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  return NextResponse.json(allProductRows(parseRange(sp.get('from'), sp.get('to'))));
}