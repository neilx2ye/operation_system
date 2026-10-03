import { NextResponse, type NextRequest } from 'next/server';
import { badRequest, errorResponse, nowIso, readJsonBody, str } from '@/lib/edm/http';
import { cacheIdentities, identityKey, isMailable } from '@/lib/edm/service';
import { requireRead } from '@/lib/integrations/klaviyo/write-gate';
import { lookupProfilesByEmail } from '@/lib/integrations/klaviyo/profiles';
import { candidateHashOf, resolveCandidates } from '@/lib/integrations/klaviyo/operations';

export const dynamic = 'force-dynamic';

const MAX_RETURNED = 500;

/**
 * 按受众批量匹配 Klaviyo Profile 并读取订阅/抑制状态。
 * 显式请求 additional-fields[profile]=subscriptions；未知状态一律不计入可营销。
 * 结果里只返回 OPS 本地客户 ID，不回传邮箱。
 */
export async function POST(req: NextRequest) {
  try {
    const { cfg, accountId } = requireRead(req);
    const b = await readJsonBody(req);
    const audienceId = str(b.audienceId);
    if (!audienceId) throw badRequest('缺少 audienceId');

    const { audience, candidates } = resolveCandidates(audienceId);
    if (audience.dataSource === 'mock') {
      throw badRequest('当前受众来自演示数据(Mock)，不能与真实 Klaviyo 账号做匹配');
    }

    const remote = await lookupProfilesByEmail(candidates.map((c) => c.emailKey), cfg);
    const byEmail = new Map(remote.filter((r) => r.email).map((r) => [r.email as string, r]));

    const entries: Parameters<typeof cacheIdentities>[0] = [];
    const results: Record<string, unknown>[] = [];
    let matched = 0;
    let notFound = 0;
    let mailable = 0;
    let pending = 0;

    for (const { customer, emailKey } of candidates) {
      const hit = byEmail.get(emailKey) ?? null;
      const status = hit?.status ?? null;
      if (hit) {
        matched++;
        if (isMailable(status ?? undefined)) mailable++;
        else pending++;
        if (status) {
          entries.push({
            key: identityKey(audience.storeKey, accountId, customer.id),
            identity: { profileId: hit.id, email: emailKey, verifiedAt: nowIso(), source: 'lookup' },
            status,
          });
        }
      } else {
        notFound++;
      }
      if (results.length < MAX_RETURNED) {
        results.push({
          customerRef: customer.id,
          status: hit ? 'matched' : 'not_found',
          canReceiveEmail: status?.canReceiveEmail ?? null,
          subscribed: status?.subscribed ?? null,
          consent: status?.consent ?? null,
          globalSuppressed: status?.globalSuppressed ?? null,
          listSuppressed: status?.listSuppressed ?? null,
          suppressionReasons: status?.suppressionReasons ?? [],
          profileId: hit?.id ?? null,
          checkedAt: status?.checkedAt ?? nowIso(),
        });
      }
    }

    cacheIdentities(entries);
    return NextResponse.json({
      audienceId: audience.id,
      candidateHash: candidateHashOf(audience.sourceRevision, candidates),
      summary: { total: candidates.length, matched, notFound, failed: 0, mailable, pending },
      truncated: candidates.length > results.length,
      results,
    });
  } catch (e) {
    return errorResponse(e);
  }
}