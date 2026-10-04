import { NextResponse, type NextRequest } from 'next/server';
import { getIntegrationState, identityKey } from '@/lib/edm/service';
import { errorResponse, readJsonBody } from '@/lib/edm/http';
import type { KlaviyoMarketingStatus } from '@/lib/edm/types';

export const dynamic = 'force-dynamic';

/**
 * 只读本地缓存：客户表格用它批量取营销状态，不发任何外部请求。
 * 需要真正刷新时由操作员显式触发 /profiles/lookup。
 */
export async function POST(req: NextRequest) {
  try {
    const b = await readJsonBody(req);
    const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map((v) => String(v)).filter((v) => /^[A-Za-z0-9_-]{1,64}$/.test(v)))].slice(0, 500) : [];
    const { binding, marketing } = await getIntegrationState();
    const statuses: Record<string, KlaviyoMarketingStatus> = {};
    for (const id of ids) {
      const s = marketing[identityKey(binding.storeKey, binding.accountId, id)];
      if (s) statuses[id] = s;
    }
    const matched = Object.keys(statuses).length;
    return NextResponse.json({
      accountId: binding.accountId,
      storeKey: binding.storeKey,
      matched,
      unknown: ids.length - matched,
      statuses,
    });
  } catch (e) {
    return errorResponse(e);
  }
}