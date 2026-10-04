import { NextResponse, type NextRequest } from 'next/server';
import { catalogRows, updateCatalog } from '@/lib/mock';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json(await catalogRows());
}

/** body: { patches: { [productId]: { price?, cost?, stock?, ... } } } */
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body || typeof body.patches !== 'object' || body.patches === null) {
      return NextResponse.json({ error: '缺少 patches' }, { status: 400 });
    }
    const updated = await updateCatalog(body.patches);
    return NextResponse.json({ updated, rows: await catalogRows() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
