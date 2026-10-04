import { NextResponse, type NextRequest } from 'next/server';
import { lintTemplate } from '@/lib/edm/service';
import { errorResponse, readJsonBody } from '@/lib/edm/http';

export const dynamic = 'force-dynamic';

/** 邮件 HTML 检查：不依赖数据库，可以对着草稿直接跑 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const b = await readJsonBody(req);
    return NextResponse.json(await lintTemplate(id, typeof b.html === 'string' ? b.html : undefined));
  } catch (e) {
    return errorResponse(e);
  }
}