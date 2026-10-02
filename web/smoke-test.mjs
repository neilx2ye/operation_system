// OPS Next.js MVP 冒烟测试：自动拉起生产服务器，逐个校验页面与 API。
// 用法: npm run build && node smoke-test.mjs
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.SMOKE_PORT || 3918);
const BASE = `http://localhost:${PORT}`;
const NEXT_BIN = fileURLToPath(new URL('./node_modules/next/dist/bin/next', import.meta.url));

const server = spawn(process.execPath, [NEXT_BIN, 'start'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});

function shutdown(code) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  else server.kill();
  process.exit(code);
}

async function waitForReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/products`);
      if (r.ok) return;
    } catch {
      /* 服务器尚未监听 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`服务器在 ${timeoutMs}ms 内未就绪`);
}

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' -> ' + detail : ''}`);
  if (!ok) failures.push(name);
}

async function main() {
  await waitForReady();

  for (const path of ['/products', '/customers', '/relations']) {
    const r = await fetch(BASE + path);
    check(`GET ${path}`, r.status === 200, `HTTP ${r.status}`);
  }

  const home = await fetch(BASE + '/', { redirect: 'manual' });
  check('GET / 跳转到 /products', home.status === 307 && home.headers.get('location') === '/products', `HTTP ${home.status}`);

  const products = await (await fetch(`${BASE}/api/products`)).json();
  check('/api/products 行数', products.length === 16, `${products.length} 行`);
  check(
    '/api/products 字段完整',
    ['title', 'units', 'revenue', 'refundRate', 'profit', 'margin', 'buyers', 'trend30'].every((k) => k in products[0]),
  );

  const ranged = await (await fetch(`${BASE}/api/products?from=2026-09-01&to=2026-10-01`)).json();
  const fullRevenue = products.reduce((s, p) => s + p.revenue, 0);
  const rangedRevenue = ranged.reduce((s, p) => s + p.revenue, 0);
  check('/api/products 日期范围生效', rangedRevenue > 0 && rangedRevenue < fullRevenue, `范围内 $${rangedRevenue} < 全量 $${fullRevenue}`);

  const customers = await (await fetch(`${BASE}/api/customers`)).json();
  check('/api/customers 行数', customers.length === 150, `${customers.length} 行`);

  const relations = await (await fetch(`${BASE}/api/relations`)).json();
  check('/api/relations 行数', relations.length === 50, `${relations.length} 行`);
  check('/api/relations Lift 计算', relations[0].lift > 0, `lift=${relations[0].lift}`);

  const p1 = await (await fetch(`${BASE}/api/products/p1`)).json();
  check('/api/products/p1 详情', p1.weekly.length === 26 && Array.isArray(p1.buyersList) && Array.isArray(p1.coProducts),
    `weekly=${p1.weekly.length} buyers=${p1.buyersList.length} co=${p1.coProducts.length}`);

  const c1 = await (await fetch(`${BASE}/api/customers/c1`)).json();
  check('/api/customers/c1 详情', Array.isArray(c1.products) && Array.isArray(c1.timeline), `timeline=${c1.timeline.length}`);

  const missing = await fetch(`${BASE}/api/products/nope`);
  check('未知产品返回 404', missing.status === 404, `HTTP ${missing.status}`);

  const hotReload = await fetch(`${BASE}/api/hot-reload`);
  check('生产模式不暴露热重载通道', hotReload.status === 404, `HTTP ${hotReload.status}`);

  console.log(failures.length ? `\n${failures.length} 项失败: ${failures.join(', ')}` : '\n全部通过');
  shutdown(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.log('ERR', e.message);
  shutdown(1);
});