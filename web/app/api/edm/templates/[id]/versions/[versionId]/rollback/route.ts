import { NextResponse, type NextRequest } from 'next/server';
import { rollbackVersion } from '@/lib/edm/service';
import { errorResponse, readJsonBody } from '@/lib/edm/http';

export const dynamic = 'force-dynamic';

/** 回滚不改写旧版本，而是复制出一个新版本 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; versionId: string }> }) {
  try {
    const { id, versionId } = await ctx.params;
    const b = await readJsonBody(req);
    const expected = typeof b.expectedRevision === 'number' ? b.expectedRevision : undefined;
    return NextResponse.json(rollbackVersion(id, versionId, expected), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}