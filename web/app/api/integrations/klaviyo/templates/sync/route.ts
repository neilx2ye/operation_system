import { NextResponse, type NextRequest } from 'next/server';
import { errorResponse, readJsonBody, str } from '@/lib/edm/http';
import { runTemplateSync } from '@/lib/integrations/klaviyo/operations';
import { requireWrite } from '@/lib/integrations/klaviyo/write-gate';

export const dynamic = 'force-dynamic';

/** 推送已冻结的本地模板版本；模板不是客户数据，因此不受 Mock 数据源限制 */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireWrite(req, { customerData: false });
    const b = await readJsonBody(req);
    const operation = await runTemplateSync(ctx, {
      templateId: str(b.templateId),
      versionId: str(b.versionId) || undefined,
      onConflict: b.onConflict === 'new' ? 'new' : 'fail',
      confirm: str(b.confirm),
    });
    return NextResponse.json({ operation }, { status: 202 });
  } catch (e) {
    return errorResponse(e);
  }
}