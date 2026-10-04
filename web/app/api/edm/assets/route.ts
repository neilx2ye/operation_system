import { NextResponse, type NextRequest } from 'next/server';
import { createAsset, listAssets } from '@/lib/edm/service';
import { badRequest, errorResponse, tooLarge } from '@/lib/edm/http';
import { ASSET_MAX_BYTES } from '@/lib/edm/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json({ assets: await listAssets() });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData().catch(() => null);
    if (!form) throw badRequest('请求必须是 multipart/form-data');
    const file = form.get('file');
    if (!(file instanceof File)) throw badRequest('缺少 file 字段');
    if (file.size > ASSET_MAX_BYTES) throw tooLarge(`图片超过 ${Math.round(ASSET_MAX_BYTES / 1024 / 1024)} MB 上限`);
    const body = Buffer.from(await file.arrayBuffer());
    return NextResponse.json(await createAsset({ filename: file.name, mime: file.type, body }), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}