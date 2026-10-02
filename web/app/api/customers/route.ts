import { NextResponse } from 'next/server';
import { allCustomerRows } from '@/lib/mock';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json(allCustomerRows());
}