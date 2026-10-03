import { NextResponse, type NextRequest } from 'next/server';
import { duplicateTemplate } from '@/lib/edm/service';
import { errorResponse, readJsonBody, str } from '@/lib/edm/http';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const b = await readJsonBody(req);
    return NextResponse.json(duplicateTemplate(id, str(b.name) || undefined), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}