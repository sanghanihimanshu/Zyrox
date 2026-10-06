// Runs the example backend over HTTP: `pnpm --filter @zyrox-examples/shop-api start`.
// Point the example apps at it with `apiBaseUrl` (the Zyrox server only serves UI, never your data).
import { createServer } from 'node:http';
import { handleShopRequest, ShopError } from './api';
import { orderUpdate, shopEvents } from './ui';

const port = Number(process.env.PORT ?? 4600);

createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization, last-event-id, cache-control');
  if (req.method === 'OPTIONS') return void res.writeHead(204).end();
  const url = new URL(req.url ?? '/', 'http://localhost');
  // UI pushed to the app as server-sent events. A real backend takes the user from the session.
  if (req.method === 'GET' && url.pathname === '/ui/events')
    return shopEvents.pipe(url.searchParams.get('user') ?? 'demo', req, res);
  // Demo: `curl -X POST localhost:4600/ui/demo/order?user=demo` shows an order update in the app.
  if (req.method === 'POST' && url.pathname === '/ui/demo/order') {
    const id = shopEvents.publish(url.searchParams.get('user') ?? 'demo', orderUpdate(String(Date.now())));
    return void res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ id }));
  }
  let body: unknown;
  if (req.method !== 'GET') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  }
  try {
    const result = await handleShopRequest({ method: req.method ?? 'GET', url: req.url ?? '/', body });
    res
      .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify(result));
  } catch (err) {
    const status = err instanceof ShopError ? err.status : 500;
    res.writeHead(status, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        message: (err as Error).message,
        ...(err instanceof ShopError && err.body ? (err.body as object) : {}),
      }),
    );
  }
}).listen(port, () => console.log(`Shop API on http://localhost:${port}`));
