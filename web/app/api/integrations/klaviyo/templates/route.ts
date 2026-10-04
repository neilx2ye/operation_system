import { NextResponse, type NextRequest } from 'next/server';
import { errorResponse } from '@/lib/edm/http';
import { requireRead } from '@/lib/integrations/klaviyo/write-gate';
import { listRemoteTemplates } from '@/lib/integrations/klaviyo/templates';

export const dynamic = 'force-dynamic';

/** 读取远端模板清单；就地读不需要写入开关，但需要已验证的操作员 */
export async function GET(req: NextRequest) {
  try {
    const { cfg } = await requireRead(req);
    return NextResponse.json({ templates: await listRemoteTemplates(cfg) });
  } catch (e) {
    return errorResponse(e);
  }
}