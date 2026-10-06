import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildManifest, type Document } from '@wishyor/zyrox-protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import counterJson from '../../../examples/components/documents/counter.json';
import productJson from '../../../examples/components/documents/product.json';
import { actionDefs, componentDefs, helperNames } from '../../../examples/components/src/defs';
import { createZyroxServer, verifySignature, type ZyroxServer } from '../src';

const counter = counterJson as unknown as Document;
const product = productJson as unknown as Document;
const manifest = buildManifest({
  components: componentDefs,
  actions: actionDefs,
  helpers: helperNames,
  motions: ['fade'],
  transitions: ['slide'],
});
const oldManifest = buildManifest({
  components: componentDefs.filter((d) => d.name !== 'Badge'),
  actions: actionDefs,
});

let server: ZyroxServer;
let cookie = '';
let keys: Record<string, string> = {};

interface Res {
  status: number;
  body: any;
  headers: Headers;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Res> {
  const res = await server.app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

function client(env: string, extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${keys[env]}`,
    'x-zyrox-client': `platform=web; app=1.0.0; manifest=${manifest.hash}; protocol=1`,
    'x-zyrox-user': 'user-1',
    ...extra,
  };
}

const bootstrap = async (env: string, extra: Record<string, string> = {}) =>
  (await call('GET', '/v1/bootstrap', undefined, client(env, extra))).body;

beforeAll(async () => {
  server = await createZyroxServer({
    database: process.env.ZYROX_TEST_DATABASE_URL ?? 'memory://',
    counterIntervalMs: 0,
    // The webhook test calls a server on localhost.
    allowPrivateUrls: true,
    secretKey: 'test secret key',
    functions: {
      applyCoupon: (args) => ({ total: Number(args.amount) * 0.9, code: args.code }),
      boom: () => {
        throw new Error('Exploded');
      },
    },
  });
});

afterAll(async () => {
  await server?.close();
});

describe('auth', () => {
  it('lets the first user sign up as owner, then closes sign-up', async () => {
    expect((await call('GET', '/api/auth/status')).body).toMatchObject({
      hasUsers: false,
      openSignup: true,
      user: null,
    });
    const signup = await call('POST', '/api/auth/signup', {
      email: 'Ada@Example.com',
      password: 'correct horse',
      name: 'Ada',
    });
    expect(signup.status).toBe(200);
    expect(signup.body.user).toMatchObject({ email: 'ada@example.com', owner: true });
    cookie = signup.headers.get('set-cookie')!.split(';')[0]!;
    expect((await call('GET', '/api/me')).body.user.name).toBe('Ada');
    const profile = await call('PATCH', '/api/me', { name: 'Ada Lovelace' });
    expect(profile.body.user).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com' });
    const second = await call('POST', '/api/auth/signup', {
      email: 'eve@example.com',
      password: 'password123',
    });
    expect(second.status).toBe(403);
    const saved = cookie;
    cookie = '';
    expect(
      (await call('POST', '/api/auth/login', { email: 'ada@example.com', password: 'wrong password' }))
        .status,
    ).toBe(401);
    expect((await call('GET', '/api/me')).status).toBe(401);
    expect(
      (await call('POST', '/api/auth/login', { email: 'ada@example.com', password: 'correct horse' })).status,
    ).toBe(200);
    cookie = saved;
  });

  it('issues personal access tokens', async () => {
    const created = await call('POST', '/api/tokens', { name: 'cli' });
    expect(created.body.token).toMatch(/^zyx_/);
    const saved = cookie;
    cookie = '';
    expect(
      (await call('GET', '/api/me', undefined, { authorization: `Bearer ${created.body.token}` })).body.user
        .email,
    ).toBe('ada@example.com');
    cookie = saved;
    expect((await call('GET', '/api/tokens')).body.tokens).toHaveLength(1);
  });

  it('validates input', async () => {
    const res = await call('POST', '/api/auth/signup', { email: 'not-an-email', password: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid');
  });
});

describe('projects, manifests and documents', () => {
  it('creates a project with dev, staging and prod environments', async () => {
    const res = await call('POST', '/api/projects', { name: 'Shop', slug: 'shop' });
    expect(res.status).toBe(201);
    expect(res.body.environments.map((e: { key: string }) => e.key)).toEqual(['dev', 'staging', 'prod']);
    keys = Object.fromEntries(
      res.body.environments.map((e: { key: string; publicKey: string }) => [e.key, e.publicKey]),
    );
    expect(keys.prod).toMatch(/^pk_prod_/);
    expect((await call('POST', '/api/projects', { name: 'Again', slug: 'shop' })).status).toBe(409);
    expect((await call('GET', '/api/projects/shop')).body.role).toBe('admin');
    expect((await call('GET', '/api/projects/nope')).status).toBe(404);
  });

  it('deletes a project and its dependent data', async () => {
    await call('POST', '/api/projects', { name: 'Temporary', slug: 'temporary' });
    const deleted = await call('DELETE', '/api/projects/temporary');
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ ok: true });
    expect((await call('GET', '/api/projects/temporary')).status).toBe(404);
  });

  it('accepts manifests and rejects tampered ones', async () => {
    expect(
      (await call('POST', '/api/projects/shop/manifests', { manifest: oldManifest, label: '0.9.0' })).status,
    ).toBe(201);
    expect((await call('POST', '/api/projects/shop/manifests', { manifest, label: '1.0.0' })).status).toBe(
      201,
    );
    const tampered = { ...manifest, helpers: ['sneaky'] };
    expect((await call('POST', '/api/projects/shop/manifests', { manifest: tampered })).status).toBe(400);
    const list = await call('GET', '/api/projects/shop/manifests');
    expect(list.body.manifests[0]).toMatchObject({ hash: manifest.hash, latest: true, label: '1.0.0' });
  });

  it('creates documents from templates or content', async () => {
    const fromTemplate = await call('POST', '/api/projects/shop/documents', {
      key: 'about',
      kind: 'screen',
      title: 'About',
    });
    expect(fromTemplate.status).toBe(201);
    expect(fromTemplate.body.draft.content.root).toEqual({ id: 'root', type: 'Screen', children: [] });
    const created = await call('POST', '/api/projects/shop/documents', {
      key: 'counter',
      kind: 'screen',
      content: counter,
    });
    expect(created.body.draft.revision).toBe(1);
    expect(
      (await call('POST', '/api/projects/shop/documents', { key: 'counter', kind: 'screen' })).status,
    ).toBe(409);
    expect(
      (await call('POST', '/api/projects/shop/documents', { key: 'strings/x y', kind: 'strings' })).status,
    ).toBe(400);
    const list = await call('GET', '/api/projects/shop/documents');
    expect(list.body.documents.map((d: { key: string }) => d.key)).toEqual(['about', 'counter']);
    expect(list.body.documents[1]).toMatchObject({ dirty: true, latest: null, live: {} });
  });

  it('saves drafts with optimistic locking and applies ops', async () => {
    const doc = await call('GET', '/api/projects/shop/documents/counter');
    const stale = await call('PUT', '/api/projects/shop/documents/counter/draft', {
      content: doc.body.draft.content,
      revision: 99,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.revision).toBe(1);
    const ops = await call('POST', '/api/projects/shop/documents/counter/ops', {
      revision: 1,
      ops: [{ op: 'update', id: 'value', set: { 'props.text': 'Total: {{ state.count }}' } }],
    });
    expect(ops.body.draft.revision).toBe(2);
    expect(ops.body.inverse).toEqual([
      { op: 'update', id: 'value', set: { 'props.text': 'Count: {{ state.count }}' } },
    ]);
    const bad = await call('POST', '/api/projects/shop/documents/counter/ops', {
      ops: [{ op: 'remove', id: 'nope' }],
    });
    expect(bad.status).toBe(422);
  });

  it('validates, publishes and releases', async () => {
    const validation = await call('POST', '/api/projects/shop/documents/counter/validate', {});
    expect(validation.body.problems).toEqual([]);
    const published = await call('POST', '/api/projects/shop/documents/counter/publish', {
      message: 'First',
      release: ['dev'],
    });
    expect(published.status).toBe(200);
    expect(published.body.version).toMatchObject({ number: 1 });
    expect(published.body.version.ref).toMatch(/^d_[0-9a-f]{40}$/);
    const again = await call('POST', '/api/projects/shop/documents/counter/publish', {});
    expect(again.body.version.number).toBe(1);
    const broken = await call('POST', '/api/projects/shop/documents', {
      key: 'broken',
      kind: 'screen',
      content: {
        zyrox: 1,
        kind: 'screen',
        key: 'broken',
        root: { id: 'r', type: 'Screen', children: [{ id: 'x', type: 'Nope' }] },
      },
    });
    expect(broken.status).toBe(201);
    const rejected = await call('POST', '/api/projects/shop/documents/broken/publish', {});
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.details.problems[0]).toMatchObject({ code: 'unknown_component', nodeId: 'x' });
    const list = await call('GET', '/api/projects/shop/documents');
    expect(list.body.documents.find((d: { key: string }) => d.key === 'counter')).toMatchObject({
      dirty: false,
      live: { dev: { number: 1 } },
    });
  });
});

describe('delivery', () => {
  it('serves a per-user bootstrap and immutable documents', async () => {
    const res = await call('GET', '/v1/bootstrap', undefined, client('dev'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    expect(res.body).toMatchObject({
      ttl: 60,
      experiments: [],
      strings: { defaultLocale: 'en', refs: {}, translate: false },
    });
    // Unchanged bootstraps revalidate with a 304.
    const etag = res.headers.get('etag')!;
    expect(etag).toMatch(/^"b_/);
    expect(
      (await call('GET', '/v1/bootstrap', undefined, client('dev', { 'if-none-match': etag }))).status,
    ).toBe(304);
    const ref = res.body.docs.counter;
    const doc = await call('GET', `/v1/docs/${ref}`);
    expect(doc.body.root.children[0].props.text).toBe('Total: {{ state.count }}');
    expect(doc.headers.get('cache-control')).toContain('immutable');
    // Small documents go out as is; larger ones precompressed once (Brotli preferred, then gzip).
    const small = await server.app.request(`/v1/docs/${ref}`, { headers: { 'accept-encoding': 'gzip, br' } });
    expect(small.headers.get('content-encoding')).toBeNull();
    const cached = (await server.ctx.delivery.content(ref))!;
    const { brotliDecompressSync, gunzipSync } = await import('node:zlib');
    expect(brotliDecompressSync(new Uint8Array(await cached.encoded('br'))).toString()).toBe(cached.json);
    expect(gunzipSync(new Uint8Array(await cached.encoded('gzip'))).toString()).toBe(cached.json);
    expect(await cached.encoded('br')).toBe(await cached.encoded('br'));
    expect((await call('GET', `/v1/docs/${ref}`, undefined, { 'if-none-match': `"${ref}"` })).status).toBe(
      304,
    );
    expect((await call('GET', '/v1/docs/d_missing')).status).toBe(404);
    expect((await call('GET', `/v1/strings/${ref}`)).status).toBe(404);
    expect((await bootstrap('prod')).docs).toEqual({});
    expect((await call('GET', '/v1/bootstrap', undefined, { authorization: 'Bearer pk_nope' })).status).toBe(
      401,
    );
  });

  it('targets versions with rules, rollouts and experiments', async () => {
    await call('POST', '/api/projects/shop/documents/counter/ops', {
      ops: [{ op: 'update', id: 'value', set: { 'props.text': 'v2 {{ state.count }}' } }],
    });
    const v2 = (await call('POST', '/api/projects/shop/documents/counter/publish', { message: 'v2' })).body
      .version;
    await call('POST', '/api/projects/shop/documents/counter/ops', {
      ops: [{ op: 'update', id: 'value', set: { 'props.text': 'v3 {{ state.count }}' } }],
    });
    const v3 = (await call('POST', '/api/projects/shop/documents/counter/publish', { message: 'v3' })).body
      .version;
    const v1Ref = (await bootstrap('dev')).docs.counter;

    const setRelease = await call('PUT', '/api/projects/shop/environments/dev/releases/counter', {
      version: 1,
      rules: [
        { name: 'iOS 1.x', when: "client.platform == 'ios' && semver(client.app, '>=1.0')", version: 2 },
        { name: 'Nobody yet', when: "attrs.country == 'IN'", rollout: 0, version: 3 },
      ],
    });
    expect(setRelease.status).toBe(200);
    const ios = await bootstrap('dev', {
      'x-zyrox-client': `platform=ios; app=1.2.0; manifest=${manifest.hash}`,
    });
    expect(ios.docs.counter).toBe(v2.ref);
    expect((await bootstrap('dev')).docs.counter).toBe(v1Ref);
    expect((await bootstrap('dev', { 'x-zyrox-attrs': 'country=IN' })).docs.counter).toBe(v1Ref);
    expect(
      (
        await call('PUT', '/api/projects/shop/environments/dev/releases/counter', {
          version: 1,
          rules: [{ when: 'client.platform ==', version: 2 }],
        })
      ).status,
    ).toBe(400);

    const experiment = await call('POST', '/api/projects/shop/experiments', {
      key: 'counter-copy',
      document: 'counter',
      variants: [
        { key: 'control', version: 1, weight: 50 },
        { key: 'bold', version: 3, weight: 50 },
      ],
    });
    expect(experiment.status).toBe(201);
    await call('PUT', '/api/projects/shop/environments/dev/releases/counter', {
      version: 1,
      rules: [{ experiment: 'counter-copy' }],
    });
    expect((await bootstrap('dev')).experiments).toEqual([]);
    await call('PATCH', '/api/projects/shop/experiments/counter-copy', { status: 'running' });
    const seen = new Map<string, string>();
    for (let i = 0; i < 40; i++) {
      const b = await bootstrap('dev', { 'x-zyrox-user': `u${i}` });
      expect(b.experiments).toHaveLength(1);
      seen.set(b.experiments[0].variant, b.docs.counter);
    }
    expect(seen.get('control')).toBe(v1Ref);
    expect(seen.get('bold')).toBe(v3.ref);
    const first = await bootstrap('dev', { 'x-zyrox-user': 'sticky' });
    for (let i = 0; i < 5; i++)
      expect((await bootstrap('dev', { 'x-zyrox-user': 'sticky' })).experiments).toEqual(first.experiments);
    const releases = await call('GET', '/api/projects/shop/environments/dev/releases');
    expect(releases.body.releases[0].rules[0]).toMatchObject({ experiment: 'counter-copy' });
  });

  it('rolls back and promotes between environments', async () => {
    await call('PUT', '/api/projects/shop/environments/dev/releases/counter', { version: 3 });
    const rollback = await call('POST', '/api/projects/shop/environments/dev/releases/counter/rollback');
    expect(rollback.body.version).toBe(2);
    const promote = await call('POST', '/api/projects/shop/promote', { from: 'dev', to: 'prod' });
    expect(promote.body.promoted).toEqual(['counter']);
    expect((await bootstrap('prod')).docs.counter).toBe((await bootstrap('dev')).docs.counter);
  });

  it('expands blocks into screens', async () => {
    await call('POST', '/api/projects/shop/documents', {
      key: 'promo-banner',
      kind: 'block',
      content: {
        zyrox: 1,
        kind: 'block',
        key: 'promo-banner',
        root: {
          id: 'card',
          type: 'Card',
          props: { title: '{{ input.title }}' },
          children: [{ id: 'badge', type: 'Badge', props: { label: 'Sale' } }],
        },
      },
    });
    const blockPublish = await call('POST', '/api/projects/shop/documents/promo-banner/publish', {});
    expect(blockPublish.body.problems).toEqual([]);
    const home: Document = {
      zyrox: 1,
      kind: 'screen',
      key: 'home',
      root: {
        id: 'root',
        type: 'Screen',
        children: [{ id: 'promo', type: '@block/promo-banner', props: { title: 'Summer' } }],
      },
    };
    await call('POST', '/api/projects/shop/documents', { key: 'home', kind: 'screen', content: home });
    const published = await call('POST', '/api/projects/shop/documents/home/publish', { release: ['dev'] });
    expect(published.status).toBe(200);
    const content = (await call('GET', `/v1/docs/${published.body.version.ref}`)).body;
    expect(content.root.children[0]).toMatchObject({
      id: 'promo',
      type: 'Card',
      with: { input: { title: 'Summer' } },
      props: { title: '{{ input.title }}' },
      children: [{ id: 'promo/badge', type: 'Badge' }],
    });
    expect(
      (await call('PUT', '/api/projects/shop/environments/dev/releases/promo-banner', { version: 1 })).status,
    ).toBe(400);
  });

  it('reports which app builds a document would break', async () => {
    await call(
      'GET',
      '/v1/bootstrap',
      undefined,
      client('prod', { 'x-zyrox-client': `platform=android; app=0.9.0; manifest=${oldManifest.hash}` }),
    );
    await call('GET', '/v1/bootstrap', undefined, client('prod'));
    await server.ctx.counters.flush();
    const validation = await call('POST', '/api/projects/shop/documents/counter/validate', {});
    expect(validation.body.compat).toHaveLength(1);
    expect(validation.body.compat[0]).toMatchObject({
      hash: oldManifest.hash,
      label: '0.9.0',
      problems: [expect.objectContaining({ code: 'unknown_component', nodeId: 'lots' })],
    });
    expect(validation.body.compat[0].share).toBeGreaterThan(0);
  });

  it('delivers translations as released documents', async () => {
    await call('POST', '/api/projects/shop/documents', { key: 'strings/fr', kind: 'strings' });
    const draft = (await call('GET', '/api/projects/shop/documents/strings/fr')).body.draft;
    expect(draft.content).toEqual({ zyrox: 1, kind: 'strings', locale: 'fr', messages: {} });
    await call('PUT', '/api/projects/shop/documents/strings/fr/draft', {
      revision: draft.revision,
      content: { ...draft.content, messages: { 'home.title': 'Accueil' } },
    });
    const published = await call('POST', '/api/projects/shop/documents/strings/fr/publish', {
      release: ['dev'],
    });
    expect(published.body.version.ref).toMatch(/^s_/);
    const b = await bootstrap('dev', { 'accept-language': 'fr-CA,fr;q=0.9,en;q=0.5' });
    expect(b.strings).toMatchObject({
      defaultLocale: 'en',
      refs: { fr: published.body.version.ref },
      suggested: 'fr',
    });
    expect((await call('GET', `/v1/strings/${published.body.version.ref}`)).body.messages).toEqual({
      'home.title': 'Accueil',
    });
  });
});

describe('remote functions', () => {
  it('runs code functions and records results', async () => {
    const ok = await call(
      'POST',
      '/v1/functions/applyCoupon',
      { args: { amount: 100, code: 'SAVE10' }, screen: 'cart' },
      client('dev'),
    );
    expect(ok.body).toEqual({ result: { total: 90, code: 'SAVE10' } });
    const failed = await call('POST', '/v1/functions/boom', { args: {} }, client('dev'));
    expect(failed.status).toBe(500);
    expect(failed.body.error.message).toBe('Exploded');
    expect((await call('POST', '/v1/functions/nope', {}, client('dev'))).status).toBe(404);
  });

  it('forwards signed requests to webhook functions in your cloud', async () => {
    let received: { headers: Record<string, string | string[] | undefined>; body: string } | undefined;
    const cloud = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        received = { headers: req.headers, body };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ result: { quote: 42 } }));
      });
    });
    await new Promise<void>((r) => cloud.listen(0, r));
    const url = `http://127.0.0.1:${(cloud.address() as AddressInfo).port}/quote`;
    const created = await call('POST', '/api/projects/shop/functions', { name: 'quote', url });
    expect(created.body.function.secret).toMatch(/^whsec_/);
    const res = await call('POST', '/v1/functions/quote', { args: { items: 3 } }, client('dev'));
    expect(res.body).toEqual({ result: { quote: 42 } });
    expect(JSON.parse(received!.body)).toMatchObject({
      fn: 'quote',
      args: { items: 3 },
      context: { environment: { key: 'dev' }, user: 'user-1' },
    });
    expect(
      verifySignature(
        created.body.function.secret,
        String(received!.headers['x-zyrox-timestamp']),
        received!.body,
        String(received!.headers['x-zyrox-signature']),
      ),
    ).toBe(true);
    const test = await call('POST', '/api/projects/shop/functions/quote/test', { args: {} });
    expect(test.body).toMatchObject({ ok: true, result: { quote: 42 } });
    const list = await call('GET', '/api/projects/shop/functions');
    expect(list.body.functions.map((f: { name: string; kind: string }) => `${f.kind}:${f.name}`)).toEqual([
      'code:applyCoupon',
      'code:boom',
      'webhook:quote',
    ]);
    expect(JSON.stringify(list.body)).not.toContain('whsec_');
    cloud.close();
  });
});

describe('telemetry and health', () => {
  it('aggregates views, errors, exposures, functions and builds', async () => {
    const ref = (await bootstrap('prod')).docs.counter;
    const sent = await call(
      'POST',
      '/v1/telemetry',
      {
        events: [
          { type: 'screen_view', screen: 'counter', version: ref, count: 9 },
          {
            type: 'error',
            screen: 'counter',
            version: ref,
            kind: 'render',
            nodeId: 'value',
            message: 'kaboom',
            count: 1,
          },
          { type: 'exposure', experiment: 'counter-copy', variant: 'bold', count: 4 },
        ],
      },
      client('prod'),
    );
    expect(sent.status).toBe(200);
    expect(
      (await call('POST', '/v1/telemetry', { events: [{ type: 'bogus' }] }, client('prod'))).status,
    ).toBe(400);
    const health = await call('GET', '/api/projects/shop/health?env=prod');
    const screen = health.body.screens.find((s: { key: string }) => s.key === 'counter');
    expect(screen).toMatchObject({ views: 9, errors: 1, errorRate: 1 / 9 });
    expect(screen.topErrors[0]).toMatchObject({ kind: 'render', nodeId: 'value', message: 'kaboom' });
    expect(health.body.experiments).toEqual({ 'counter-copy': { bold: 4 } });
    expect(health.body.builds.map((b: { label: string }) => b.label).sort()).toEqual(['0.9.0', '1.0.0']);
    const devHealth = await call('GET', '/api/projects/shop/health?env=dev');
    expect(devHealth.body.functions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'applyCoupon', ok: 1 }),
        expect.objectContaining({ name: 'boom', error: 1 }),
      ]),
    );
  });
});

describe('roles and audit', () => {
  it('enforces roles', async () => {
    const owner = cookie;
    await call('POST', '/api/users', { email: 'viewer@example.com', password: 'password123', name: 'Vi' });
    await call('PUT', '/api/projects/shop/members', { email: 'viewer@example.com', role: 'viewer' });
    cookie = '';
    const login = await call('POST', '/api/auth/login', {
      email: 'viewer@example.com',
      password: 'password123',
    });
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    expect((await call('GET', '/api/projects/shop/documents')).status).toBe(200);
    expect((await call('POST', '/api/projects/shop/documents/counter/publish', {})).status).toBe(403);
    expect((await call('POST', '/api/projects/shop/documents', { key: 'x', kind: 'screen' })).status).toBe(
      403,
    );
    expect(
      (await call('POST', '/api/users', { email: 'z@example.com', password: 'password123' })).status,
    ).toBe(403);
    cookie = owner;
  });

  it('records an audit trail', async () => {
    const audit = await call('GET', '/api/projects/shop/audit');
    const actions = audit.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'project.create',
        'document.publish',
        'release.set',
        'release.rollback',
        'release.promote',
        'function.create',
        'member.set',
      ]),
    );
    expect(audit.body.entries[0].actor).toBe('Ada Lovelace');
  });
});

describe('live preview relay', () => {
  it('relays drafts from the dashboard to devices', async () => {
    const listening = await server.listen(0, '127.0.0.1');
    const session = (await call('POST', '/api/projects/shop/preview-sessions')).body;
    const token = (await call('POST', '/api/tokens', { name: 'preview' })).body.token;
    const base = `ws://127.0.0.1:${listening.port}`;
    const open = (url: string, headers?: Record<string, string>) =>
      new Promise<{ ws: WebSocket; messages: any[] }>((resolve, reject) => {
        const ws = new WebSocket(url, { headers });
        const messages: any[] = [];
        ws.on('message', (data) => messages.push(JSON.parse(String(data))));
        ws.on('open', () => resolve({ ws, messages }));
        ws.on('error', reject);
      });
    const waitFor = async (messages: any[], predicate: (m: any) => boolean) => {
      for (let i = 0; i < 100; i++) {
        const found = messages.find(predicate);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('Timed out waiting for message');
    };

    const editor = await open(`${base}/api/preview/${session.id}/ws`, { authorization: `Bearer ${token}` });
    const device = await open(`${base}/v1/preview/${session.id}?token=${session.token}`);
    device.ws.send(JSON.stringify({ type: 'hello', platform: 'ios', manifest: manifest.hash }));
    await waitFor(editor.messages, (m) => m.type === 'devices' && m.devices[0]?.platform === 'ios');

    editor.ws.send(JSON.stringify({ type: 'document', document: product }));
    const received = await waitFor(device.messages, (m) => m.type === 'document');
    expect(received.document.key).toBe('product');
    editor.ws.send(
      JSON.stringify({
        type: 'ops',
        ops: [{ op: 'update', id: 'name', set: { 'props.variant': 'subtitle' } }],
      }),
    );
    await waitFor(
      device.messages,
      (m) => m.type === 'document' && m.document.root.children[2].children[0].props.variant === 'subtitle',
    );

    device.ws.send(JSON.stringify({ type: 'event', event: { type: 'error', message: 'oops' } }));
    await waitFor(editor.messages, (m) => m.type === 'event' && m.event.message === 'oops');

    const intruder = new WebSocket(`${base}/v1/preview/${session.id}?token=wrong`);
    const code = await new Promise<number>((resolve) => intruder.on('close', (c) => resolve(c)));
    expect(code).toBe(4401);

    editor.ws.close();
    device.ws.close();
    await listening.close();
  });
});
