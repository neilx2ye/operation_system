import { ServiceError } from '@/lib/edm/http';
import { requireOpsAccess } from '@/lib/ops-access';
import { getBinding } from '@/lib/edm/service';
import { klaviyoConfig, type KlaviyoConfig } from './config';
import type { KlaviyoBinding } from '@/lib/edm/types';

// 真实写入的统一闸门。
//
// 四道条件必须同时满足，缺一即拒绝：
//   1. 已验证的操作员身份（requireOpsAccess + Origin 校验）
//   2. 服务端 KLAVIYO_ENABLE_WRITES=true
//   3. 设置页的「允许真实写入」已打开
//   4. 私钥已配置
// Mock 数据只能用于设计模拟，永远不允许进入真实客户写入。

export type WriteContext = {
  cfg: KlaviyoConfig;
  binding: KlaviyoBinding;
  storeKey: string;
  operator: { subject: string; via: string };
};

export async function requireWrite(req: Request, opts: { customerData: boolean }): Promise<WriteContext> {
  const op = requireOpsAccess(req, { write: true });
  if (!op.ok) throw new ServiceError(op.code, op.reason, op.code === 'unauthorized' ? 401 : 403);

  const binding = await getBinding();
  const cfg = klaviyoConfig();
  if (!cfg) throw new ServiceError('writes_disabled', '未配置 KLAVIYO_PRIVATE_API_KEY，真实写入不可用', 403);
  if (!cfg.writesEnabled) {
    throw new ServiceError('writes_disabled', '服务端 KLAVIYO_ENABLE_WRITES 未开启，真实写入不可用（模板设计与模拟流程仍可使用）', 403);
  }
  if (!binding.writesEnabled) {
    throw new ServiceError('writes_disabled', '设置页的「允许真实写入」未开启', 403);
  }
  if (opts.customerData) {
    if (!binding.accountId) throw new ServiceError('writes_disabled', '尚未核对 Klaviyo 账号，请先到设置页测试连接', 403);
    if (!binding.storeKey) throw new ServiceError('writes_disabled', '尚未确认店铺绑定，请先到设置页填写店铺绑定', 403);
  }
  return { cfg, binding, storeKey: binding.storeKey, operator: { subject: op.subject, via: op.via } };
}

/** 只读取本地记录（不访问 Klaviyo）时，只要求已验证的操作员 */
export function requireOperator(req: Request): void {
  const op = requireOpsAccess(req, { write: false });
  if (!op.ok) throw new ServiceError(op.code, op.reason, op.code === 'unauthorized' ? 401 : 403);
}

/** 只读的 Klaviyo 调用（不涉及写入开关），但仍要求已验证操作员，避免用私钥为匿名请求服务 */
export async function requireRead(req: Request): Promise<{ cfg: KlaviyoConfig; accountId: string | null; storeKey: string }> {
  const op = requireOpsAccess(req, { write: false });
  if (!op.ok) throw new ServiceError(op.code, op.reason, op.code === 'unauthorized' ? 401 : 403);
  const cfg = klaviyoConfig();
  if (!cfg) throw new ServiceError('unavailable', '未配置 KLAVIYO_PRIVATE_API_KEY，无法访问 Klaviyo', 503, false);
  const binding = await getBinding();
  return { cfg, accountId: binding.accountId, storeKey: binding.storeKey };
}

export function confirmTemplate(templateId: string, versionHash: string): string {
  return `sync-template:${templateId}:${versionHash}`;
}

export function confirmProfiles(audienceId: string, candidateHash: string): string {
  return `sync-profile:${audienceId}:${candidateHash}`;
}

export function confirmList(listId: string, audienceId: string, candidateHash: string): string {
  return `add-to-list:${listId}:${audienceId}:${candidateHash}`;
}