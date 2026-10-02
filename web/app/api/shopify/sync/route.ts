import { NextResponse } from 'next/server';
import { readStatus, startSync } from '@/lib/shopifySync';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(readStatus());
}

export async function POST() {
  const result = startSync();
  return NextResponse.json(
    { ...result, status: readStatus() },
    { status: result.started ? 202 : 409 },
  );
}
