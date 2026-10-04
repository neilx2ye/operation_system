import { NextResponse } from 'next/server';
import { allCustomerRows } from '@/lib/mock';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(await allCustomerRows());
}