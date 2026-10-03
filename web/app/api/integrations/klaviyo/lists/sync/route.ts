import { NextResponse, type NextRequest } from 'next/server';
import { badRequest, errorResponse, readJsonBody, str } from '@/lib/edm/http';
import { runListSync } from '@/lib/integrations/klaviyo/operations';
import { requireWrite } from '@/lib/integrations/klaviyo/write-gate';

export const dynamic = 'force-dynamic';

/** 向已确认的目标名单增加符合本期订阅规则的成员（只增加，不删除） */
export async function POST(req: NextRequest) {
  try {
    const ctx = requireWrite(req, { customerData: true });
    const b = await readJsonBody(req);
    const listId = str(b.listId);
    if (!listId) throw badRequest('缺少 listId');
    const operation = await runListSync(ctx, {
      audienceId: str(b.audienceId),
      listId,
      confirm: str(b.confirm),
    });
    return NextResponse.json({ operation }, { status: 202 });
  } catch (e) {
    return errorResponse(e);
  }
}