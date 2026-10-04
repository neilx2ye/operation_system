import { NextResponse, type NextRequest } from 'next/server';
import { createTemplate, listTemplates } from '@/lib/edm/service';
import { errorResponse, readJsonBody, str } from '@/lib/edm/http';
import type { TemplateOrigin } from '@/lib/edm/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    return NextResponse.json(await listTemplates({ q: sp.get('q') ?? undefined, categoryId: sp.get('categoryId') ?? undefined }));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const b = await readJsonBody(req);
    const origin = str(b.origin);
    return NextResponse.json(
      await createTemplate({
        name: str(b.name),
        categoryId: str(b.categoryId) || null,
        storeKey: str(b.storeKey),
        subject: str(b.subject),
        previewText: str(b.previewText),
        html: typeof b.html === 'string' ? b.html : undefined,
        origin: origin === 'import' || origin === 'klaviyo' ? (origin as TemplateOrigin) : 'blank',
        note: str(b.note) || undefined,
      }),
      { status: 201 },
    );
  } catch (e) {
    return errorResponse(e);
  }
}