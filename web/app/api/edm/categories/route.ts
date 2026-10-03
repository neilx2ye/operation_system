import { NextResponse, type NextRequest } from 'next/server';
import { listCategories, upsertCategory } from '@/lib/edm/service';
import { errorResponse, readJsonBody, str } from '@/lib/edm/http';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json({ categories: listCategories() });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const b = await readJsonBody(req);
    return NextResponse.json({ category: upsertCategory(str(b.name), str(b.id) || undefined) });
  } catch (e) {
    return errorResponse(e);
  }
}