import { NextResponse, type NextRequest } from 'next/server';
import { siteAnalytics } from '@/lib/shopifyAnalytics';

export const dynamic = 'force-dynamic';

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const to = sp.get('to') || iso(new Date());
  const from = sp.get('from') || iso(new Date(Date.now() - 13 * 86_400_000));
  try {
    return NextResponse.json(await siteAnalytics(from, to));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 502 });
  }
}