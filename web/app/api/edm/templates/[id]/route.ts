import { NextResponse, type NextRequest } from 'next/server';
import { deleteTemplate, getTemplateBundle, updateTemplate } from '@/lib/edm/service';
import { errorResponse, readJsonBody, str } from '@/lib/edm/http';
import type { TemplateStatus, UpdateTemplateInput } from '@/lib/edm/types';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const STATUSES: TemplateStatus[] = ['draft', 'ready', 'archived'];

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    return NextResponse.json(getTemplateBundle(id));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const b = await readJsonBody(req);
    if (typeof b.revision !== 'number') {
      return NextResponse.json({ code: 'bad_request', message: '缺少 revision（乐观并发版本号）', retryable: false }, { status: 400 });
    }
    const patch: UpdateTemplateInput = { revision: b.revision };
    // 只接受显式给出的字段：未出现的键不参与更新
    if ('name' in b) patch.name = str(b.name);
    if ('categoryId' in b) patch.categoryId = str(b.categoryId) || null;
    if ('storeKey' in b) patch.storeKey = str(b.storeKey);
    if ('subject' in b) patch.subject = str(b.subject);
    if ('previewText' in b) patch.previewText = str(b.previewText);
    if ('status' in b && STATUSES.includes(b.status as TemplateStatus)) patch.status = b.status as TemplateStatus;
    return NextResponse.json({ template: updateTemplate(id, patch) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    deleteTemplate(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}