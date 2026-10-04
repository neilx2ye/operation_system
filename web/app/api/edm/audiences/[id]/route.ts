import { NextResponse, type NextRequest } from 'next/server';
import { loadAudience } from '@/lib/edm/service';
import { errorResponse } from '@/lib/edm/http';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { audience, valid, invalidReason } = await loadAudience(id);
    return NextResponse.json({ audience, valid, invalidReason });
  } catch (e) {
    return errorResponse(e);
  }
}