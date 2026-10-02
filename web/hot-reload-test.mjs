// OPS 热重载冒烟测试：拉起 next dev，订阅 /api/hot-reload，改动数据层文件后应收到 reload 事件。
// 用法: node hot-reload-test.mjs   （跑之前请先停掉其它 next dev / next start 实例，它们共用 .next）
import { spawn, spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.HOT_RELOAD_PORT || 3919);
const BASE = `http://localhost:${PORT}`;
const NEXT_BIN = fileURLToPath(new URL('./node_modules/next/dist/bin/next', import.meta.url));
// 探针文件放在被监听的数据层目录里，写完即删，不参与编译产物。
const PROBE = fileURLToPath(new URL('./lib/hot-reload-probe.ts', import.meta.url));

const server = spawn(process.execPath, [NEXT_BIN, 'dev', '--port', String(PORT)], { stdio: 'ignore' });

function shutdown(code) {
  rmSync(PROBE, { force: true });
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  else server.kill();
  process.exit(code);
}

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' -> ' + detail : ''}`);
  if (!ok) failures.push(name);
}

async function waitForReady(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/products`);
      if (r.ok) return;
    } catch {
      /* 开发服务器尚未监听或还在首次编译 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`开发服务器在 ${timeoutMs}ms 内未就绪`);
}

async function main() {
  await waitForReady();

  const res = await fetch(`${BASE}/api/hot-reload`);
  const type = res.headers.get('content-type') || '';
  check('热重载通道可用', res.ok && type.includes('text/event-stream'), `HTTP ${res.status} ${type}`);

  let buffer = '';
  const decoder = new TextDecoder();
  const pump = (async () => {
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
    } catch {
      /* 服务器关闭时读取会中断 */
    }
  })();

  const waitFor = async (predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate(buffer)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  check('连接后立即收到 ready', await waitFor((b) => b.includes('"type":"ready"'), 10_000), buffer.trim().split('\n')[0]);

  writeFileSync(PROBE, 'export const probe = 1;\n');
  check('数据层文件变更后收到 reload', await waitFor((b) => b.includes('"type":"reload"'), 20_000));
  check('reload 事件带文件名', await waitFor((b) => b.includes('hot-reload-probe'), 5_000));
  rmSync(PROBE, { force: true });

  const page = await fetch(`${BASE}/products`);
  check('热重载期间页面仍可访问', page.status === 200, `HTTP ${page.status}`);

  console.log(failures.length ? `\n${failures.length} 项失败: ${failures.join(', ')}` : '\n全部通过');
  pump.catch(() => {});
  shutdown(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.log('ERR', e.message);
  shutdown(1);
});