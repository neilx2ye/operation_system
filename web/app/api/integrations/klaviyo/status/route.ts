import { NextResponse, type NextRequest } from 'next/server';
import { getBinding } from '@/lib/edm/service';
import { apiRevision, hasKlaviyoKey, keyMaskFromEnv, writesEnabledByEnv } from '@/lib/integrations/klaviyo/config';
import { accessSummary } from '@/lib/ops-access';
import { errorResponse } from '@/lib/edm/http';

export const dynamic = 'force-dynamic';

/** 脱敏状态：不返回私钥，只返回「是否已配置」与末位掩码 */
export async function GET(req: NextRequest) {
  try {
    const binding = getBinding();
    const access = accessSummary(req);
    const envWrites = writesEnabledByEnv();
    return NextResponse.json({
      configured: hasKlaviyoKey(),
      keyMask: keyMaskFromEnv(),
      account: binding.accountId ? { id: binding.accountId, label: binding.accountLabel } : null,
      apiRevision: apiRevision(),
      storeKey: binding.storeKey,
      defaultListId: binding.defaultListId,
      defaultListName: binding.defaultListName,
      // 真实写入必须同时满足：环境开关 + 本地开关 + 已验证的操作员
      writesEnabled: envWrites && binding.writesEnabled && access.operatorVerified,
      writesEnabledByEnv: envWrites,
      writesEnabledByBinding: binding.writesEnabled,
      lastCheck: binding.lastCheck,
      lastCheckedAt: binding.lastCheckedAt,
      access,
    });
  } catch (e) {
    return errorResponse(e);
  }
}