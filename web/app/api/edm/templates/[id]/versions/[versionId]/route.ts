import { NextResponse, type NextRequest } from 'next/server';
import { getVersion } from '@/lib/edm/service';
import { errorResponse } from '@/lib/edm/http';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string; versionId: string }> }) {
  try {
    const { id, versionId } = await ctx.params;
    return NextResponse.json({ version: await getVersion(id, versionId) });
  } catch (e) {
    return errorResponse(e);
  }
}