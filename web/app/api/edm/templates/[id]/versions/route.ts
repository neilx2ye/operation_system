import { NextResponse, type NextRequest } from 'next/server';
import { listVersions, saveVersion } from '@/lib/edm/service';
import { errorResponse, readJsonBody, str } from '@/lib/edm/http';
import type { VersionSource } from '@/lib/edm/types';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    return NextResponse.json({ versions: await listVersions(id) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const b = await readJsonBody(req);
    if (typeof b.html !== 'string') {
      return NextResponse.json({ code: 'bad_request', message: '缺少 html', retryable: false }, { status: 400 });
    }
    const source = str(b.source);
    const allowed: VersionSource[] = ['manual', 'import', 'klaviyo'];
    return NextResponse.json(
      await saveVersion(id, {
        html: b.html,
        note: str(b.note),
        expectedRevision: typeof b.expectedRevision === 'number' ? b.expectedRevision : undefined,
        source: allowed.includes(source as VersionSource) ? (source as VersionSource) : 'manual',
      }),
      { status: 201 },
    );
  } catch (e) {
    return errorResponse(e);
  }
}