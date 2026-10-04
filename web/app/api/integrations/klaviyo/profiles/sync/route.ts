import { NextResponse, type NextRequest } from 'next/server';
import { errorResponse, readJsonBody, str } from '@/lib/edm/http';
import { runProfileSync } from '@/lib/integrations/klaviyo/operations';
import { requireWrite } from '@/lib/integrations/klaviyo/write-gate';

export const dynamic = 'force-dynamic';

/**
 * 只同步客户资料字段：不订阅、不重新订阅、不加名单、不取消抑制。
 * 界面与接口都不得把这一步表述为「用户已同意营销」。
 */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireWrite(req, { customerData: true });
    const b = await readJsonBody(req);
    const operation = await runProfileSync(ctx, {
      audienceId: str(b.audienceId),
      fields: b.fields,
      currency: typeof b.currency === 'string' ? b.currency : null,
      confirm: str(b.confirm),
    });
    return NextResponse.json({ operation }, { status: 202 });
  } catch (e) {
    return errorResponse(e);
  }
}