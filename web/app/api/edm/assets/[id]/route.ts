import { NextResponse, type NextRequest } from 'next/server';
import { deleteAsset, readAssetBody } from '@/lib/edm/service';
import { errorResponse } from '@/lib/edm/http';

export const dynamic = 'force-dynamic';

/** 设计预览直接引用这个地址；它不是公开 CDN，推送 Klaviyo 前必须换成远端 image_url */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { asset, body } = await readAssetBody(id);
    // Buffer 是 Uint8Array<ArrayBufferLike>，显式复制成 ArrayBuffer 支撑的视图才能作为 BodyInit
    return new NextResponse(new Uint8Array(body), {
      headers: {
        'Content-Type': asset.mime,
        'Content-Length': String(body.length),
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    await deleteAsset(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}