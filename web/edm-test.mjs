// EDM 本地设计 + Klaviyo 拦截冒烟测试。
//
// 覆盖方案第 14 节里「无需真实 Klaviyo 账号即可验证」的部分：
//   · 无数据库、无私钥时模板可创建/保存/读回/回滚
//   · 素材上传、引用检查、被引用时禁止删除
//   · 受众快照与失效判定
//   · Mock 数据与未开启写入时，服务端一律拦截真实写入（不只是隐藏按钮）
//   · 私钥不出现在任何响应里
//
// 用法（先构建到隔离目录，避免覆盖开发服务器的 .next）：
//   NEXT_DIST_DIR=.next-verify npx next build
//   NEXT_DIST_DIR=.next-verify node edm-test.mjs
// 也可以直接对已有服务跑：OPS_TEST_BASE=http://localhost:3000 node edm-test.mjs

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.EDM_TEST_PORT || 3921);
const SPAWN = !process.env.OPS_TEST_BASE;
const BASE = process.env.OPS_TEST_BASE || `http://localhost:${PORT}`;
const NEXT_BIN = fileURLToPath(new URL('./node_modules/next/dist/bin/next', import.meta.url));

const server = SPAWN
  ? spawn(process.execPath, [NEXT_BIN, 'start'], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: 'ignore',
    })
  : null;

function shutdown(code) {
  if (server) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    else server.kill();
  }
  process.exit(code);
}

async function waitForReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/products`);
      if (r.ok) return;
    } catch {
      /* 尚未监听 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`服务器在 ${timeoutMs}ms 内未就绪（${BASE}）`);
}

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' -> ' + detail : ''}`);
  if (!ok) failures.push(name);
}

async function api(path, init) {
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应保留原文 */
  }
  return { status: res.status, json, text, contentType: res.headers.get('content-type') || '' };
}

const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const patch = (path, body) => api(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const WITHDRAWAL = '<a href="{{ unsubscribe_link }}">退订</a>';
const HTML_V1 = `<!DOCTYPE html><html><head><title>t</title></head><body><table><tr><td><p>你好 {{ first_name }}</p></td></tr></table>${WITHDRAWAL}</body></html>`;
const HTML_V2 = HTML_V1.replace('你好', '欢迎回来');

// 1x1 PNG（魔数校验通过）
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const created = { templates: [], assets: [] };

async function cleanup() {
  for (const id of created.templates) await api(`/api/edm/templates/${id}`, { method: 'DELETE' }).catch(() => {});
  for (const id of created.assets) await api(`/api/edm/assets/${id}`, { method: 'DELETE' }).catch(() => {});
}

async function main() {
  await waitForReady();

  // ---------- 页面 ----------
  for (const path of ['/edm', '/customers', '/settings']) {
    const r = await api(path);
    check(`GET ${path}`, r.status === 200, `HTTP ${r.status}`);
  }

  // ---------- 模板 CRUD ----------
  const create = await post('/api/edm/templates', { name: 'EDM 自检模板', subject: '自检', html: HTML_V1 });
  check('创建模板 201', create.status === 201 && create.json?.template?.id, `HTTP ${create.status}`);
  const templateId = create.json?.template?.id;
  const versionId = create.json?.version?.id;
  if (!templateId) throw new Error('创建模板失败，后续检查无法继续');
  created.templates.push(templateId);
  check('模板版本带 hash', typeof create.json.version.hash === 'string' && create.json.version.hash.length === 64, create.json.version.hash?.slice(0, 12));

  const list = await api('/api/edm/templates');
  check(
    '/api/edm/templates 列表包含新模板',
    list.status === 200 && Array.isArray(list.json?.templates) && list.json.templates.some((t) => t.id === templateId) && Array.isArray(list.json?.categories),
    `${list.json?.templates?.length} 个模板`,
  );

  const bundle = await api(`/api/edm/templates/${templateId}`);
  check(
    '读回模板与版本',
    bundle.status === 200 && bundle.json?.version?.html === HTML_V1 && Array.isArray(bundle.json?.versions),
    `versions=${bundle.json?.versions?.length}`,
  );

  // ---------- HTML 检查 ----------
  const lintBad = await post(`/api/edm/templates/${templateId}/lint`, { html: '<html><body><p>this template has no opt-out entry</p></body></html>' });
  check(
    '缺少退订入口时检查不通过',
    lintBad.status === 200 && lintBad.json?.ok === false && lintBad.json.issues.some((i) => i.rule === 'unsubscribe' && i.level === 'error'),
    JSON.stringify(lintBad.json?.issues?.map((i) => i.rule)),
  );
  const lintGood = await post(`/api/edm/templates/${templateId}/lint`, { html: HTML_V1 });
  check('带退订入口的模板检查通过', lintGood.status === 200 && lintGood.json?.ok === true, JSON.stringify(lintGood.json?.issues ?? []));

  // ---------- 版本与乐观并发 ----------
  const revision = bundle.json.template.revision;
  const stale = await patch(`/api/edm/templates/${templateId}`, { name: '过期写入', revision: revision - 1 });
  check('过期 revision 返回 409', stale.status === 409, `HTTP ${stale.status}`);

  const renamed = await patch(`/api/edm/templates/${templateId}`, { name: 'EDM 自检模板(改名)', revision });
  check('正确 revision 可更新', renamed.status === 200 && renamed.json?.template?.name === 'EDM 自检模板(改名)', `HTTP ${renamed.status}`);

  const saved = await post(`/api/edm/templates/${templateId}/versions`, { html: HTML_V2, note: '第二版', expectedRevision: renamed.json.template.revision });
  check('保存新版本 201', saved.status === 201 && saved.json?.version?.id, `HTTP ${saved.status}`);
  const v2 = saved.json?.version?.id;

  const versions = await api(`/api/edm/templates/${templateId}/versions`);
  check('版本数量增加', versions.json?.versions?.length === 2, `${versions.json?.versions?.length} 个版本`);

  const rolled = await post(`/api/edm/templates/${templateId}/versions/${v2}/rollback`, {});
  check(
    '回滚生成新版本而不是改写旧版本',
    rolled.status === 201 && rolled.json?.version?.source === 'rollback' && rolled.json?.version?.fromVersionId === v2,
    `HTTP ${rolled.status} source=${rolled.json?.version?.source}`,
  );
  const versionsAfter = await api(`/api/edm/templates/${templateId}/versions`);
  check('回滚后旧版本仍然存在', versionsAfter.json?.versions?.length === 3, `${versionsAfter.json?.versions?.length} 个版本`);
  const rolledBack = await api(`/api/edm/templates/${templateId}/versions/${rolled.json.version.id}`);
  check('回滚版本内容等于被回滚版本', rolledBack.json?.version?.html === HTML_V2, `${rolledBack.json?.version?.html?.length} 字节`);

  // ---------- 素材 ----------
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(PNG)], { type: 'image/png' }), 'pixel.png');
  const upload = await api('/api/edm/assets', { method: 'POST', body: form });
  check('上传 PNG 素材 201', upload.status === 201 && upload.json?.asset?.id, `HTTP ${upload.status} ${upload.json?.message ?? ''}`);
  const assetId = upload.json?.asset?.id;
  if (assetId) {
    created.assets.push(assetId);
    const raw = await fetch(`${BASE}/api/edm/assets/${assetId}`);
    const bytes = Buffer.from(await raw.arrayBuffer());
    check(
      '素材按二进制读回',
      raw.status === 200 && raw.headers.get('content-type') === 'image/png' && bytes.length === PNG.length && bytes[0] === 0x89,
      `HTTP ${raw.status} ${bytes.length} 字节`,
    );

    const badUpload = new FormData();
    badUpload.append('file', new Blob([new Uint8Array(Buffer.from('not an image'))], { type: 'image/png' }), 'fake.png');
    const bad = await api('/api/edm/assets', { method: 'POST', body: badUpload });
    check('伪装成 PNG 的非图片被拒绝', bad.status === 415, `HTTP ${bad.status}`);

    // 把素材写进模板，验证「被引用时禁止删除」
    const withAsset = await post(`/api/edm/templates/${templateId}/versions`, {
      html: HTML_V2.replace('</table>', `<img src="/api/edm/assets/${assetId}" alt="pixel"></table>`),
      note: '加入素材',
    });
    check('保存引用素材的版本', withAsset.status === 201, `HTTP ${withAsset.status}`);

    const blocked = await api(`/api/edm/assets/${assetId}`, { method: 'DELETE' });
    check(
      '被引用的素材禁止删除并给出引用位置',
      blocked.status === 409 && Array.isArray(blocked.json?.references) && blocked.json.references.length > 0,
      `HTTP ${blocked.status} refs=${blocked.json?.references?.length}`,
    );
  }

  // ---------- 受众 ----------
  const preview = await post('/api/edm/audiences/preview', { mode: 'filters', filters: {} });
  const p = preview.json?.preview;
  check(
    '受众预演返回完整计数',
    preview.status === 200 && p && typeof p.total === 'number' && typeof p.validEmail === 'number' && typeof p.duplicateEmail === 'number' && typeof p.pending === 'number' && Array.isArray(p.excluded) && p.sourceRevision,
    `total=${p?.total} valid=${p?.validEmail} mock=${p?.mock}`,
  );
  check('受众预演不回传邮箱', !JSON.stringify(p ?? {}).includes('@'), p ? '无 @ 字符串' : '无响应');

  const snapshot = await post('/api/edm/audiences', { mode: 'filters', filters: {} });
  const aud = snapshot.json?.audience;
  check(
    '保存受众快照',
    snapshot.status === 201 && typeof aud?.id === 'string' && aud.id.startsWith('aud_') && Date.parse(aud.expiresAt) > Date.parse(aud.createdAt),
    `HTTP ${snapshot.status} id=${aud?.id?.slice(0, 12)}`,
  );
  if (aud?.id) {
    const loaded = await api(`/api/edm/audiences/${aud.id}`);
    check('刚保存的快照仍然有效', loaded.status === 200 && loaded.json?.valid === true, `valid=${loaded.json?.valid} reason=${loaded.json?.invalidReason}`);
  }

  // ---------- 非法 ID ----------
  const evil = await api('/api/edm/templates/..%2f..%2fetc%2fpasswd');
  check('非法 ID 不返回 200 也不 500', evil.status === 400 || evil.status === 404, `HTTP ${evil.status}`);
  const evilAsset = await api('/api/edm/assets/%2e%2e%2f%2e%2e%2fsecret');
  check('素材路径穿越被拒绝', evilAsset.status === 400 || evilAsset.status === 404, `HTTP ${evilAsset.status}`);

  // ---------- Klaviyo 只读状态 ----------
  const status = await api('/api/integrations/klaviyo/status');
  check(
    'Klaviyo 状态脱敏且标明未配置',
    status.status === 200 && status.json?.configured === false && status.json?.writesEnabled === false && typeof status.json?.keyMask === 'string',
    `configured=${status.json?.configured} writes=${status.json?.writesEnabled}`,
  );
  check('状态响应不含私钥', !status.text.includes('pk_'), status.text.includes('pk_') ? '发现 pk_ 前缀' : '未出现 pk_');

  // ---------- 写入拦截 ----------
  const writes = [
    ['模板推送', '/api/integrations/klaviyo/templates/sync', { templateId, versionId, confirm: 'x' }],
    ['资料同步', '/api/integrations/klaviyo/profiles/sync', { audienceId: aud?.id, fields: ['ops_orders'], confirm: 'x' }],
    ['名单同步', '/api/integrations/klaviyo/lists/sync', { audienceId: aud?.id, listId: 'X', confirm: 'x' }],
  ];
  for (const [label, path, body] of writes) {
    const r = await post(path, body);
    check(
      `${label}在未开启真实写入时被服务端拒绝`,
      (r.status === 403 || r.status === 503) && typeof r.json?.message === 'string' && r.status !== 200 && r.status !== 202,
      `HTTP ${r.status} ${r.json?.message ?? ''}`,
    );
  }

  const pre = await post('/api/integrations/klaviyo/preflight', { kind: 'template', templateId, versionId });
  check(
    '预检在写入未开启时给出阻断原因',
    pre.status === 200 && pre.json?.ok === false && Array.isArray(pre.json.blockers) && pre.json.blockers.length > 0 && typeof pre.json.confirm === 'string',
    `blockers=${pre.json?.blockers?.length}`,
  );

  const lookups = await post('/api/integrations/klaviyo/profiles/lookup', { audienceId: aud?.id });
  check(
    '未配置私钥时匹配接口不可用',
    lookups.status === 403 || lookups.status === 503,
    `HTTP ${lookups.status} ${lookups.json?.message ?? ''}`,
  );

  // ---------- 设置写入的原子性 ----------
// 被拒绝的请求不能留下半次写入。这里把当前值原样回传，即使校验失效也不会改变配置。
const sBefore = (await api('/api/settings')).json;
const roundTrip = {
  yuntu: {
    baseUrl: sBefore?.yuntu?.baseUrl ?? '',
    customerCode: sBefore?.yuntu?.customerCode ?? '',
    apiSecret: '',
    channelCode: sBefore?.yuntu?.channelCode ?? '',
    unitWeightKg: sBefore?.yuntu?.unitWeightKg ?? '0.3',
  },
  shopify: { shop: sBefore?.shopify?.shop ?? '', adminToken: '', apiVersion: sBefore?.shopify?.apiVersion ?? '2025-07' },
  klaviyo: { apiRevision: '不是日期' },
};
const rejectedPut = await api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(roundTrip) });
const sAfter = (await api('/api/settings')).json;
check(
  '被拒绝的设置写入不改变现有配置',
  rejectedPut.status === 400 && JSON.stringify(sBefore?.yuntu) === JSON.stringify(sAfter?.yuntu) && JSON.stringify(sBefore?.shopify) === JSON.stringify(sAfter?.shopify),
  `HTTP ${rejectedPut.status}`,
);
check('设置响应不泄露密钥', sAfter?.shopify?.adminToken === '' && sAfter?.yuntu?.apiSecret === '' && !JSON.stringify(sAfter).includes('pk_'));

// ---------- 清场 ----------
  await cleanup();
  const after = await api('/api/edm/templates');
  check('测试模板已清理', after.json?.templates?.every((t) => t.id !== templateId) === true, `剩余 ${after.json?.templates?.length} 个模板`);

  console.log(failures.length ? `\n${failures.length} 项失败: ${failures.join(', ')}` : '\n全部通过');
  shutdown(failures.length ? 1 : 0);
}

main().catch(async (e) => {
  console.log('ERR', e.message);
  await cleanup().catch(() => {});
  shutdown(1);
});