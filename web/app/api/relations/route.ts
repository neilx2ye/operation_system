import { NextResponse, type NextRequest } from 'next/server';
import { relations } from '@/lib/mock';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  return NextResponse.json(relations(req.nextUrl.searchParams.get('productId')));
}