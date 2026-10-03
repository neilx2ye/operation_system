import { NextResponse, type NextRequest } from 'next/server';
import { getPreparation } from '@/lib/edm/service';
import { errorResponse } from '@/lib/edm/http';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return NextResponse.json({ preparation: getPreparation(id) });
  } catch (e) {
    return errorResponse(e);
  }
}