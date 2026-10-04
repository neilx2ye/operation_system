import { NextResponse } from 'next/server';
import { readStatus, startSync } from '@/lib/shopifySync';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(await readStatus());
}

// POST /api/shopify/sync            -> 全量同步
// POST /api/shopify/sync?mode=incremental -> 只拉取自上次以来的变更
export async function POST(req: Request) {
  const mode = new URL(req.url).searchParams.get('mode') === 'incremental' ? 'incremental' : 'full';
  const result = await startSync(mode);
  return NextResponse.json(
    { ...result, status: await readStatus() },
    { status: result.started ? 202 : 409 },
  );
}
