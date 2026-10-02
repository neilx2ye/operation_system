import { subscribeHotReload } from '@/lib/hotReload';

export const dynamic = 'force-dynamic';

// 开发期热重载推送通道：数据层文件变化时向浏览器发一条 reload 事件。
export function GET(req: Request) {
  if (process.env.NODE_ENV === 'production') {
    return new Response('生产模式未启用热重载', { status: 404 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          cleanup();
        }
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* 流已关闭 */
        }
      };

      send({ type: 'ready' });
      unsubscribe = subscribeHotReload((event) => send({ type: 'reload', ...event }));
      heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(': keep-alive\n\n'));
      }, 20_000);
      req.signal.addEventListener('abort', cleanup);
    },
    cancel() {
      closed = true;
      unsubscribe();
      clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}