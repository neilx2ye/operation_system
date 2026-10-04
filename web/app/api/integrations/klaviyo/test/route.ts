import { NextResponse, type NextRequest } from 'next/server';
import { testConnection } from '@/lib/integrations/klaviyo/accounts';
import { errorResponse } from '@/lib/edm/http';
import { requireOpsAccess } from '@/lib/ops-access';
import { klaviyoConfig } from '@/lib/integrations/klaviyo/config';
import { updateBinding } from '@/lib/edm/service';

export const dynamic = 'force-dynamic';

/**
 * 测试连接：调用 GET /api/accounts 核对账号身份。
 * 这是无副作用读取，所以不要求写入开关；但它使用私钥，因此仍要求已验证的操作员。
 * 账号检查成功不代表拥有所有写权限，写权限一律显示为「首次操作验证」。
 */
export async function POST(req: NextRequest) {
  try {
    const op = requireOpsAccess(req, { write: false });
    if (!op.ok) {
      return NextResponse.json({ code: op.code, message: op.reason, retryable: false }, { status: op.code === 'unauthorized' ? 401 : 403 });
    }
    if (!klaviyoConfig()) {
      return NextResponse.json({ ok: false, account: null, accounts: 0, detail: '未配置 KLAVIYO_PRIVATE_API_KEY', readable: [], unverified: [] });
    }
    const result = await testConnection();
    const at = new Date().toISOString();
    await updateBinding({
      lastCheckedAt: at,
      lastCheck: { ok: result.ok, detail: result.detail },
      ...(result.account ? { accountId: result.account.id, accountLabel: result.account.label } : {}),
    });
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}