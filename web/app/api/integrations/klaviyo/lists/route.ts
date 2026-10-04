import { NextResponse, type NextRequest } from 'next/server';
import { errorResponse } from '@/lib/edm/http';
import { cacheLists } from '@/lib/edm/service';
import { requireRead } from '@/lib/integrations/klaviyo/write-gate';
import { fetchLists } from '@/lib/integrations/klaviyo/lists';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { cfg } = await requireRead(req);
    const lists = await fetchLists(cfg);
    await cacheLists(lists);
    return NextResponse.json({ lists });
  } catch (e) {
    return errorResponse(e);
  }
}