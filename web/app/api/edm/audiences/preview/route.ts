import { NextResponse, type NextRequest } from 'next/server';
import { computeAudience, parseAudienceRequest, publicPreview } from '@/lib/edm/service';
import { errorResponse, readJsonBody } from '@/lib/edm/http';

export const dynamic = 'force-dynamic';

/** 受众预演：服务端按当前数据源重新计算，只返回人数与排除原因，不回传邮箱 */
export async function POST(req: NextRequest) {
  try {
    const b = await readJsonBody(req);
    return NextResponse.json({ preview: publicPreview(await computeAudience(parseAudienceRequest(b))) });
  } catch (e) {
    return errorResponse(e);
  }
}