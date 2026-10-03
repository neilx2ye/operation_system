import { NextResponse, type NextRequest } from 'next/server';
import { errorResponse } from '@/lib/edm/http';
import { listOperations } from '@/lib/edm/service';
import { requireOperator } from '@/lib/integrations/klaviyo/write-gate';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    requireOperator(req);
    return NextResponse.json({ operations: listOperations(50) });
  } catch (e) {
    return errorResponse(e);
  }
}