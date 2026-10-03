// OPS Next.js MVP 冒烟测试：自动拉起生产服务器，逐个校验页面与 API。
// 用法: npm run build && node smoke-test.mjs
// 数据源可能是 Shopify 真实缓存或 Mock，因此只校验结构与非空，不写死行数。
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

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function main() {
  await waitForReady();

  for (const path of ['/products', '/customers', '/relations', '/site', '/ads']) {
    const r = await fetch(BASE + path);
    check(`GET ${path}`, r.status === 200, `HTTP ${r.status}`);
  }

  const home = await fetch(BASE + '/', { redirect: 'manual' });
  check('GET / 跳转到 /products', home.status === 307 && home.headers.get('location') === '/products', `HTTP ${home.status}`);

  const source = await (await fetch(`${BASE}/api/data-source`)).json();
  check('/api/data-source 数据源合法', source.source === 'shopify' || source.source === 'mock', `source=${source.source}`);

  const products = await (await fetch(`${BASE}/api/products`)).json();
  check('/api/products 非空', products.length > 0, `${products.length} 行 · source=${source.source}`);
  check(
    '/api/products 字段完整',
    ['title', 'units', 'revenue', 'refundRate', 'profit', 'margin', 'buyers', 'trend30'].every((k) => k in products[0]),
  );

  const today = new Date();
  const from = iso(new Date(today.getTime() - 30 * 86_400_000));
  const ranged = await (await fetch(`${BASE}/api/products?from=${from}&to=${iso(today)}`)).json();
  const fullRevenue = products.reduce((s, p) => s + p.revenue, 0);
  const rangedRevenue = ranged.reduce((s, p) => s + p.revenue, 0);
  check('/api/products 日期范围生效', rangedRevenue > 0 && rangedRevenue <= fullRevenue, `近30天 $${rangedRevenue.toFixed(2)} ≤ 全量 $${fullRevenue.toFixed(2)}`);

  const customers = await (await fetch(`${BASE}/api/customers`)).json();
  check('/api/customers 非空', customers.length > 0, `${customers.length} 行`);

  const relations = await (await fetch(`${BASE}/api/relations`)).json();
  check('/api/relations 非空且 ≤50', relations.length > 0 && relations.length <= 50, `${relations.length} 行`);
  check('/api/relations Lift 计算', relations[0].lift > 0, `lift=${relations[0].lift}`);

  const pid = products[0].id;
  const p = await (await fetch(`${BASE}/api/products/${encodeURIComponent(pid)}`)).json();
  check('/api/products/:id 详情', p.weekly?.length === 26 && Array.isArray(p.buyersList) && Array.isArray(p.coProducts),
    `weekly=${p.weekly?.length} buyers=${p.buyersList?.length} co=${p.coProducts?.length}`);

  const cid = customers[0].id;
  const c = await (await fetch(`${BASE}/api/customers/${encodeURIComponent(cid)}`)).json();
  check('/api/customers/:id 详情', Array.isArray(c.products) && Array.isArray(c.timeline), `timeline=${c.timeline?.length}`);

  const orders = await (await fetch(`${BASE}/api/orders`)).json();
  check('/api/orders 非空', orders.length > 0, `${orders.length} 行`);
  if (orders.length) {
    const od = await (await fetch(`${BASE}/api/orders?id=${encodeURIComponent(orders[0].id)}`)).json();
    check('/api/orders?id 详情', Array.isArray(od.lines) && !!od.shipping, `lines=${od.lines?.length}`);
  }

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