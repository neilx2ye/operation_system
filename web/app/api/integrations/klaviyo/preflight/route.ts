import { NextResponse, type NextRequest } from 'next/server';
import { ServiceError, badRequest, errorResponse, readJsonBody, str } from '@/lib/edm/http';
import { getBinding } from '@/lib/edm/service';
import { klaviyoConfig } from '@/lib/integrations/klaviyo/config';
import { requireOpsAccess } from '@/lib/ops-access';
import { preflight, type PreflightKind, type PreflightRequest } from '@/lib/integrations/klaviyo/operations';

export const dynamic = 'force-dynamic';

const KINDS: PreflightKind[] = ['template', 'profile', 'list'];

/**
 * 预检只要求已验证的操作员：没有私钥时也要能跑，
 * 把「缺私钥 / 未开启写入」当作阻断原因报出来，而不是让整个接口失败。
 */
export async function POST(req: NextRequest) {
  try {
    const op = requireOpsAccess(req, { write: false });
    if (!op.ok) throw new ServiceError(op.code, op.reason, op.code === 'unauthorized' ? 401 : 403);

    const b = await readJsonBody(req);
    const kind = str(b.kind) as PreflightKind;
    if (!KINDS.includes(kind)) throw badRequest('kind 必须是 template、profile 或 list');

    const cfg = klaviyoConfig();
    const binding = await getBinding();
    const gateBlockers: string[] = [];
    if (!cfg) gateBlockers.push('未配置 KLAVIYO_PRIVATE_API_KEY，真实写入不可用');
    else if (!cfg.writesEnabled) gateBlockers.push('服务端 KLAVIYO_ENABLE_WRITES 未开启，真实写入不可用');
    if (!binding.writesEnabled) gateBlockers.push('设置页的「允许真实写入」未开启');
    if (!binding.accountId) gateBlockers.push('尚未核对 Klaviyo 账号，请先到设置页测试连接');
    if (!binding.storeKey) gateBlockers.push('尚未确认店铺绑定');
    if (!binding.defaultListId && kind === 'list' && !str(b.listId)) gateBlockers.push('尚未设置默认目标名单，且未指定 listId');

    const input: PreflightRequest = {
      kind,
      templateId: str(b.templateId) || undefined,
      versionId: str(b.versionId) || undefined,
      audienceId: str(b.audienceId) || undefined,
      listId: str(b.listId) || binding.defaultListId || undefined,
      fields: b.fields,
      currency: typeof b.currency === 'string' ? b.currency : null,
      onConflict: b.onConflict === 'new' ? 'new' : 'fail',
    };

    const result = await preflight({ cfg, binding, storeKey: binding.storeKey }, input);
    const blockers = [...gateBlockers, ...result.blockers];
    return NextResponse.json({ ...result, blockers, ok: blockers.length === 0 });
  } catch (e) {
    return errorResponse(e);
  }
}