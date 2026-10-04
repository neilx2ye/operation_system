import { NextResponse, type NextRequest } from 'next/server';
import { createPreparation, listPreparations } from '@/lib/edm/service';
import { errorResponse, readJsonBody, str } from '@/lib/edm/http';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const templateId = req.nextUrl.searchParams.get('templateId') ?? undefined;
    return NextResponse.json({ preparations: await listPreparations(templateId) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** 邮件准备记录 = 模板版本 + 受众 + 主题/预览文字；它不是 Klaviyo Campaign，也不代表已发送 */
export async function POST(req: NextRequest) {
  try {
    const b = await readJsonBody(req);
    return NextResponse.json(
      {
        preparation: await createPreparation({
          templateId: str(b.templateId),
          versionId: str(b.versionId) || undefined,
          audienceId: str(b.audienceId),
          subject: str(b.subject) || undefined,
          previewText: str(b.previewText) || undefined,
          accountId: str(b.accountId) || null,
        }),
      },
      { status: 201 },
    );
  } catch (e) {
    return errorResponse(e);
  }
}