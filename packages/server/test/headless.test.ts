import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Document } from '@zyrox/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import counterJson from '../../../examples/components/documents/counter.json';
import { createZyroxServer, verifySignature, type ZyroxServer } from '../src';
import { describedRoutes } from '../src/openapi';
import { eventMatches } from '../src/services/webhooks';

const counter = counterJson as unknown as Document;

let server: ZyroxServer;
let cookie = '';
let receiver: Server;
let receiverUrl = '';
const received: { headers: IncomingMessage['headers']; body: string }[] = [];
/** Status codes the receiver answers with, in order (then 200). */
const answers: number[] = [];
const keys: Record<string, string> = {};

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await server.app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

const app = (env: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${keys[env]}`,
  'x-zyrox-user': 'user-1',
  ...extra,
});

async function until<T>(fn: () => Promise<T> | T, check: (v: T) => boolean, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (check(value)) return value;
    if (Date.now() - start > ms) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 15));
  }
}

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(answers.shift() ?? 200).end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks`;

  server = await createZyroxServer({
    database: 'memory://',
    counterIntervalMs: 0,
    ai: false,
    secretKey: 'test-secret',
    allowPrivateUrls: true,
    rateLimits: false,
    webhookRetryDelays: [30, 30],
  });
  const signup = await call('POST', '/api/auth/signup', {
    email: 'ada@example.com',
    password: 'correct horse',
  });
  cookie = signup.headers.get('set-cookie')!.split(';')[0]!;
  const project = await call('POST', '/api/projects', { name: 'Shop', slug: 'shop' });
  for (const env of project.body.environments) keys[env.key] = env.publicKey;
  await call('POST', '/api/projects/shop/documents', { key: 'counter', kind: 'screen', content: counter });
  const published = await call('POST', '/api/projects/shop/documents/counter/publish', { release: ['dev'] });
  expect(published.status).toBe(200);
});

afterAll(async () => {
  await server?.close();
  await new Promise((r) => receiver?.close(r));
});

describe('webhooks', () => {
  it('matches events by name, prefix or *', () => {
    expect(eventMatches(['*'], 'document.publish')).toBe(true);
    expect(eventMatches(['release.*'], 'release.rollback')).toBe(true);
    expect(eventMatches(['release.*'], 'document.publish')).toBe(false);
    expect(eventMatches(['document.publish'], 'document.publish')).toBe(true);
  });

  it('delivers signed events, filtered by name, and retries failures', async () => {
    const created = await call('POST', '/api/projects/shop/webhooks', {
      url: receiverUrl,
      events: ['document.*'],
      description: 'CI',
    });
    expect(created.status).toBe(201);
    const secret = created.body.webhook.secret as string;
    expect(secret).toMatch(/^whsec_/);
    await call('POST', '/api/projects/shop/webhooks', {
      url: `${receiverUrl}?only=release`,
      events: ['release.*'],
    });
    const list = await call('GET', '/api/projects/shop/webhooks');
    expect(list.body.webhooks).toHaveLength(2);
    expect(list.body.webhooks[0].secret).toBeUndefined();

    answers.push(500);
    received.length = 0;
    const draft = await call('GET', '/api/projects/shop/documents/counter');
    await call('PUT', '/api/projects/shop/documents/counter/draft', {
      content: { ...counter, title: 'Counter v2' },
      revision: draft.body.draft.revision,
    });
    await call('POST', '/api/projects/shop/documents/counter/publish', { message: 'v2', release: ['dev'] });
    await until(
      () => received.length,
      (n) => n >= 2,
    );
    // Only the document.* webhook, twice: a 500, then the retry.
    expect(received.every((r) => !String(r.headers['x-zyrox-event']).startsWith('release'))).toBe(true);
    const [first, retry] = received;
    expect(first!.headers['x-zyrox-delivery']).toBe(retry!.headers['x-zyrox-delivery']);
    const payload = JSON.parse(retry!.body);
    expect(payload).toMatchObject({
      event: 'document.publish',
      project: { slug: 'shop' },
      actor: { email: 'ada@example.com' },
      target: 'counter',
      details: { number: 2 },
    });
    expect(
      verifySignature(
        secret,
        String(retry!.headers['x-zyrox-timestamp']),
        retry!.body,
        String(retry!.headers['x-zyrox-signature']),
      ),
    ).toBe(true);
    const id = created.body.webhook.id;
    const deliveries = await until(
      () => call('GET', `/api/projects/shop/webhooks/${id}/deliveries`),
      (r) => r.body.deliveries.length >= 2,
    );
    expect(
      deliveries.body.deliveries.map((d: { attempt: number; ok: boolean; status: number }) => [
        d.attempt,
        d.ok,
        d.status,
      ]),
    ).toEqual([
      [2, true, 200],
      [1, false, 500],
    ]);
  });

  it('sends a test ping and can be disabled, rotated and deleted', async () => {
    const hook = (await call('POST', '/api/projects/shop/webhooks', { url: receiverUrl })).body.webhook;
    received.length = 0;
    const ping = await call('POST', `/api/projects/shop/webhooks/${hook.id}/test`);
    expect(ping.body.delivery).toMatchObject({ ok: true, status: 200 });
    expect(JSON.parse(received.at(-1)!.body).event).toBe('ping');
    const rotated = await call('PATCH', `/api/projects/shop/webhooks/${hook.id}`, {
      rotateSecret: true,
      enabled: false,
    });
    expect(rotated.body.webhook.secret).toMatch(/^whsec_/);
    expect(rotated.body.webhook.secret).not.toBe(hook.secret);
    expect(
      (await call('PATCH', `/api/projects/shop/webhooks/${hook.id}`, { events: ['Nope!'] })).status,
    ).toBe(400);
    expect((await call('DELETE', `/api/projects/shop/webhooks/${hook.id}`)).body).toEqual({ ok: true });
    expect((await call('POST', `/api/projects/shop/webhooks/${hook.id}/test`)).status).toBe(404);
  });
});

describe('draft previews and single screens', () => {
  it('serves one released screen per client, with revalidation', async () => {
    const res = await call('GET', '/v1/screens/counter', undefined, app('dev'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ key: 'counter', document: { key: 'counter', title: 'Counter v2' } });
    expect(res.body.ref).toMatch(/^d_/);
    const again = await call(
      'GET',
      '/v1/screens/counter',
      undefined,
      app('dev', { 'if-none-match': `"${res.body.ref}"` }),
    );
    expect(again.status).toBe(304);
    expect((await call('GET', '/v1/screens/nope', undefined, app('dev'))).status).toBe(404);
    expect((await call('GET', '/v1/screens/counter', undefined, app('prod'))).status).toBe(404);
  });

  it('serves drafts to holders of a preview token', async () => {
    const draft = await call('GET', '/api/projects/shop/documents/counter');
    await call('PUT', '/api/projects/shop/documents/counter/draft', {
      content: { ...counter, title: 'Unpublished title' },
      revision: draft.body.draft.revision,
    });
    const released = await call('GET', '/v1/bootstrap', undefined, app('dev'));
    const { body: issued, status } = await call('POST', '/api/projects/shop/preview-tokens', {
      expiresInMinutes: 60,
    });
    expect(status).toBe(201);
    expect(issued.token).toMatch(/^zpv_/);
    const preview = await call(
      'GET',
      '/v1/bootstrap',
      undefined,
      app('dev', { 'x-zyrox-preview': issued.token }),
    );
    expect(preview.body.preview).toBe(true);
    expect(preview.headers.get('cache-control')).toBe('private, no-store');
    expect(preview.body.docs.counter).not.toBe(released.body.docs.counter);
    // Works in every environment of the project, even where nothing is released.
    const prod = await call(
      'GET',
      '/v1/bootstrap',
      undefined,
      app('prod', { 'x-zyrox-preview': issued.token }),
    );
    expect(prod.body.docs.counter).toBe(preview.body.docs.counter);
    const doc = await call('GET', `/v1/docs/${preview.body.docs.counter}`);
    expect(doc.body.title).toBe('Unpublished title');
    const screen = await call(
      'GET',
      '/v1/screens/counter',
      undefined,
      app('prod', { 'x-zyrox-preview': issued.token }),
    );
    expect(screen.body).toMatchObject({ preview: true, document: { title: 'Unpublished title' } });

    // Limited to some documents; invalid, tampered and foreign tokens are refused.
    const limited = (await call('POST', '/api/projects/shop/preview-tokens', { documents: ['other'] })).body
      .token;
    expect(
      (await call('GET', '/v1/bootstrap', undefined, app('dev', { 'x-zyrox-preview': limited }))).body.docs
        .counter,
    ).toBe(released.body.docs.counter);
    const tampered = `${issued.token.slice(0, -2)}xx`;
    expect(
      (await call('GET', '/v1/bootstrap', undefined, app('dev', { 'x-zyrox-preview': tampered }))).status,
    ).toBe(401);
    await call('POST', '/api/projects', { name: 'Other', slug: 'other' });
    const foreign = (await call('POST', '/api/projects/other/preview-tokens', {})).body.token;
    const refused = await call('GET', '/v1/bootstrap', undefined, app('dev', { 'x-zyrox-preview': foreign }));
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe('invalid_preview');
  });
});

describe('OpenAPI', () => {
  it('describes every route the server registers', async () => {
    const res = await call('GET', '/api/v1/openapi.json', undefined, { cookie: '' });
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    const normalize = (path: string) => path.replace(/:(\w+)(\{[^}]*\})?/g, '{$1}');
    const registered = new Set(
      server.app.routes
        .filter((r) => r.method !== 'ALL' && !r.path.includes('*'))
        .map((r) => `${r.method} ${normalize(r.path)}`)
        // `/api` mirrors `/api/v1`; WebSocket upgrades aren't HTTP APIs.
        .filter((r) => !/ \/api\/(?!v1\/)/.test(r) && !r.endsWith('/ws') && !r.includes('/v1/preview/')),
    );
    const described = new Set(describedRoutes().map(([m, p]) => `${m} ${p}`));
    expect([...registered].filter((r) => !described.has(r))).toEqual([]);
    expect([...described].filter((r) => !registered.has(r) && !r.endsWith('/openapi.json'))).toEqual([]);
    for (const path of Object.keys(res.body.paths)) expect(path).not.toContain(':');
  });
});

describe('export and import', () => {
  it('copies drafts, history, releases and settings into another project', async () => {
    await call('POST', '/api/projects/shop/functions', { name: 'quote', url: `${receiverUrl}/fn` });
    const exported = await call('GET', '/api/projects/shop/export?versions=true');
    expect(exported.headers.get('content-disposition')).toContain('shop.zyrox.json');
    const bundle = exported.body;
    expect(bundle).toMatchObject({ zyrox: 'project', version: 1, project: { slug: 'shop' } });
    const doc = bundle.documents.find((d: { key: string }) => d.key === 'counter');
    expect(doc.draft.title).toBe('Unpublished title');
    expect(doc.versions.map((v: { number: number }) => v.number)).toEqual([1, 2]);
    expect(bundle.releases).toContainEqual(
      expect.objectContaining({ environment: 'dev', document: 'counter', version: 2 }),
    );
    expect(JSON.stringify(bundle)).not.toContain('whsec_');

    const target = await call('POST', '/api/projects', { name: 'Copy', slug: 'copy' });
    const imported = await call('POST', '/api/projects/copy/import', { bundle });
    expect(imported.status).toBe(200);
    expect(imported.body).toMatchObject({ created: ['counter'], versions: 2, releases: 1, problems: [] });
    expect(imported.body.functions).toEqual([{ name: 'quote', secret: expect.stringMatching(/^whsec_/) }]);
    expect(imported.body.webhooks.length).toBeGreaterThan(0);
    const devKey = target.body.environments.find((e: { key: string }) => e.key === 'dev').publicKey;
    const original = await call('GET', '/v1/bootstrap', undefined, app('dev'));
    const copy = await call('GET', '/v1/bootstrap', undefined, { authorization: `Bearer ${devKey}` });
    expect(copy.body.docs.counter).toBe(original.body.docs.counter);
    const copied = await call('GET', '/api/projects/copy/documents/counter');
    expect(copied.body.draft.content.title).toBe('Unpublished title');

    // Again: existing documents are kept unless overwrite.
    const second = await call('POST', '/api/projects/copy/import', { bundle });
    expect(second.body).toMatchObject({ created: [], skipped: ['counter'], versions: 0, functions: [] });
    const overwrite = await call('POST', '/api/projects/copy/import', { bundle, overwrite: true });
    expect(overwrite.body.updated).toEqual(['counter']);
    expect((await call('POST', '/api/projects/copy/import', { bundle: { zyrox: 'nope' } })).status).toBe(400);
  });
});
