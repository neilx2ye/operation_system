import { NextResponse, type NextRequest } from 'next/server';
import { deleteCategory } from '@/lib/edm/service';
import { errorResponse } from '@/lib/edm/http';

export const dynamic = 'force-dynamic';

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    deleteCategory(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}