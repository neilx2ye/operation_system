import { NextResponse, type NextRequest } from 'next/server';
import { badRequest, errorResponse, readJsonBody, str } from '@/lib/edm/http';
import { getOperation } from '@/lib/edm/service';
import { requireOperator } from '@/lib/integrations/klaviyo/write-gate';
import { resumeOperation } from '@/lib/integrations/klaviyo/operations';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    requireOperator(req);
    const { id } = await ctx.params;
    return NextResponse.json({ operation: getOperation(id) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** 恢复写入必须由页面显式点击触发，不提供后台自动重试 */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const b = await readJsonBody(req);
    if (str(b.action) !== 'resume') throw badRequest('只支持 action=resume');
    return NextResponse.json({ operation: await resumeOperation(req, id) }, { status: 202 });
  } catch (e) {
    return errorResponse(e);
  }
}