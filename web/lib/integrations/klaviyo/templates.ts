import { klaviyoFetch, klaviyoListAll, type KlaviyoPage } from './client';
import { klaviyoConfig, type KlaviyoConfig } from './config';
import { forbidden } from '@/lib/edm/http';

// Klaviyo 模板适配。
//
// 本期同步目标是 CODE（自定义 HTML）模板。官方还提供 USER_DRAGGABLE / SYSTEM_DRAGGABLE，
// 其中 SYSTEM_DRAGGABLE 不能按普通 HTML 原地覆盖，因此一律拒绝更新。
// 列表接口 page[size] 上限为 10；2026-07-15 的列表响应同样包含 html。

export const TEMPLATE_PAGE_SIZE = 10;

export type RemoteTemplate = {
  id: string;
  name: string;
  editorType: string | null;
  html: string | null;
  created: string | null;
  updated: string | null;
};

type TemplateAttributes = {
  name?: string | null;
  editor_type?: string | null;
  html?: string | null;
  created?: string | null;
  updated?: string | null;
};

function toRemote(id: string, a: TemplateAttributes | undefined): RemoteTemplate {
  return {
    id,
    name: a?.name ?? '',
    editorType: a?.editor_type ?? null,
    html: typeof a?.html === 'string' ? a.html : null,
    created: a?.created ?? null,
    updated: a?.updated ?? null,
  };
}

export async function listRemoteTemplates(cfg: KlaviyoConfig | null = klaviyoConfig()): Promise<RemoteTemplate[]> {
  const rows = await klaviyoListAll<TemplateAttributes>(
    '/api/templates',
    { 'page[size]': TEMPLATE_PAGE_SIZE },
    (body: KlaviyoPage<TemplateAttributes>) => body.data ?? [],
    { cfg, label: '模板' },
  );
  return rows.map((r) => toRemote(r.id, r.attributes));
}

export async function getRemoteTemplate(id: string, cfg: KlaviyoConfig | null = klaviyoConfig()): Promise<RemoteTemplate> {
  const body = await klaviyoFetch<{ data?: { id: string; attributes?: TemplateAttributes } }>(
    { path: `/api/templates/${encodeURIComponent(id)}` },
    cfg,
  );
  if (!body?.data) throw forbidden(`Klaviyo 未返回模板 ${id}`);
  return toRemote(body.data.id, body.data.attributes);
}

/** 只允许 CODE / USER_DRAGGABLE 被 HTML 覆盖 */
export function assertHtmlEditable(editorType: string | null, templateId: string): void {
  if (editorType === 'CODE' || editorType === 'USER_DRAGGABLE' || editorType === null) return;
  throw forbidden(`远端模板 ${templateId} 的类型是 ${editorType}，不能按普通 HTML 原地覆盖；请改为另存为新模板`);
}

export async function createRemoteTemplate(
  input: { name: string; html: string },
  cfg: KlaviyoConfig | null = klaviyoConfig(),
): Promise<RemoteTemplate> {
  const body = await klaviyoFetch<{ data?: { id: string; attributes?: TemplateAttributes } }>(
    {
      method: 'POST',
      path: '/api/templates',
      body: { data: { type: 'template', attributes: { name: input.name, editor_type: 'CODE', html: input.html } } },
      idempotent: false,
    },
    cfg,
  );
  if (!body?.data) throw forbidden('Klaviyo 未返回新建模板的结果');
  return toRemote(body.data.id, body.data.attributes);
}

export async function updateRemoteTemplate(
  id: string,
  input: { name?: string; html?: string },
  cfg: KlaviyoConfig | null = klaviyoConfig(),
): Promise<RemoteTemplate> {
  const attributes: Record<string, unknown> = {};
  if (input.name !== undefined) attributes.name = input.name;
  if (input.html !== undefined) attributes.html = input.html;
  const body = await klaviyoFetch<{ data?: { id: string; attributes?: TemplateAttributes } }>(
    {
      method: 'PATCH',
      path: `/api/templates/${encodeURIComponent(id)}`,
      body: { data: { type: 'template', id, attributes } },
      idempotent: false,
    },
    cfg,
  );
  if (!body?.data) throw forbidden('Klaviyo 未返回更新模板的结果');
  return toRemote(body.data.id, body.data.attributes);
}

/** 远端渲染只用于验证传入上下文的模板渲染，不代表真实发送测试 */
export async function renderRemoteTemplate(
  id: string,
  context: Record<string, unknown>,
  cfg: KlaviyoConfig | null = klaviyoConfig(),
): Promise<string> {
  const body = await klaviyoFetch<{ data?: { attributes?: { html?: string | null } } }>(
    {
      method: 'POST',
      path: '/api/template-render',
      body: { data: { type: 'template', id, attributes: { context } } },
      idempotent: false,
    },
    cfg,
  );
  return body?.data?.attributes?.html ?? '';
}