import { NextResponse, type NextRequest } from 'next/server';
import { createAudience, listAudiencesPublic, parseAudienceRequest } from '@/lib/edm/service';
import { errorResponse, readJsonBody } from '@/lib/edm/http';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json({ audiences: await listAudiencesPublic() });
  } catch (e) {
    return errorResponse(e);
  }
}

/** 保存受众快照：冻结命中的客户 ID，24 小时后或数据源变化即失效 */
export async function POST(req: NextRequest) {
  try {
    const b = await readJsonBody(req);
    return NextResponse.json({ audience: await createAudience(parseAudienceRequest(b)) }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}