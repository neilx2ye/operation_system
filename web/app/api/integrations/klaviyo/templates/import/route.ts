import { NextResponse, type NextRequest } from 'next/server';
import { badRequest, errorResponse, nowIso, readJsonBody, str } from '@/lib/edm/http';
import { createTemplate } from '@/lib/edm/service';
import { requireRead } from '@/lib/integrations/klaviyo/write-gate';
import { assertHtmlEditable, getRemoteTemplate } from '@/lib/integrations/klaviyo/templates';

export const dynamic = 'force-dynamic';

/** 从 Klaviyo 拉取模板时先建立 OPS 本地副本，不改动远端 */
export async function POST(req: NextRequest) {
  try {
    const { cfg, accountId } = requireRead(req);
    const b = await readJsonBody(req);
    const remoteId = str(b.remoteId);
    if (!remoteId) throw badRequest('缺少 remoteId');

    const remote = await getRemoteTemplate(remoteId, cfg);
    assertHtmlEditable(remote.editorType, remoteId);
    if (!remote.html) throw badRequest('远端模板没有 HTML 内容，不能作为 CODE 模板导入');

    const created = createTemplate({
      name: str(b.name) || remote.name || `Klaviyo 模板 ${remoteId}`,
      html: remote.html,
      origin: 'klaviyo',
      note: `从 Klaviyo 导入，远端模板 ${remoteId}`,
      // 导入即建立映射；推送时仍会再次确认，并核对远端是否被他人修改
      remote: accountId ? { accountId, remoteId, syncedAt: nowIso(), remoteFingerprint: remote.updated } : null,
    });
    return NextResponse.json(created, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}