import { ScreenRuntime, ZyroxClient } from '@wishyor/zyrox-core';
import { buildManifest, type Document } from '@wishyor/zyrox-protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import counterJson from '../../../examples/components/documents/counter.json';
import { actionDefs, componentDefs } from '../../../examples/components/src/defs';
import { createZyroxServer, type ZyroxServer } from '../src';

let server: ZyroxServer;
let endpoint = '';
let stop: () => Promise<void>;
let publicKey = '';

beforeAll(async () => {
  server = await createZyroxServer({
    database: 'memory://',
    counterIntervalMs: 0,
    functions: { double: (args) => Number(args.n) * 2 },
  });
  const listening = await server.listen(0, '127.0.0.1');
  endpoint = `http://127.0.0.1:${listening.port}`;
  stop = listening.close;
  const json = { 'content-type': 'application/json' };
  const signup = await fetch(`${endpoint}/api/auth/signup`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ email: 'a@b.co', password: 'password123' }),
  });
  const auth = { ...json, cookie: signup.headers.get('set-cookie')!.split(';')[0]! };
  const project = (await (
    await fetch(`${endpoint}/api/projects`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'App', slug: 'app' }),
    })
  ).json()) as { environments: { publicKey: string }[] };
  publicKey = project.environments[0]!.publicKey;
  const manifest = buildManifest({ components: componentDefs, actions: actionDefs });
  await fetch(`${endpoint}/api/projects/app/manifests`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ manifest }),
  });
  await fetch(`${endpoint}/api/projects/app/documents`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ key: 'counter', kind: 'screen', content: counterJson }),
  });
  const published = await fetch(`${endpoint}/api/projects/app/documents/counter/publish`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ release: ['dev'] }),
  });
  expect(published.status).toBe(200);
  await fetch(`${endpoint}/api/projects/app/documents`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      key: 'strings/fr',
      kind: 'strings',
      content: { zyrox: 1, kind: 'strings', locale: 'fr', messages: { hi: 'Salut' } },
    }),
  });
  await fetch(`${endpoint}/api/projects/app/documents/strings/fr/publish`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ release: ['dev'] }),
  });
});

afterAll(async () => {
  await stop?.();
  await server?.close();
});

it('the core client talks to the real server', async () => {
  const client = new ZyroxClient({
    endpoint,
    publicKey,
    manifestHash: 'm_test',
    platform: 'web',
    telemetryInterval: 0,
    locales: () => ['fr-FR'],
  });
  await client.refresh();
  const status = client.getDocument('counter');
  expect(status.status).toBe('ready');
  const document = (status as { document: Document }).document;
  expect(document.key).toBe('counter');
  expect(client.locales()).toEqual(['fr']);
  expect(await client.loadStrings('fr')).toEqual({ hi: 'Salut' });
  expect(await client.callFunction('double', { n: 21 }, { screen: 'counter' })).toBe(42);

  const runtime = new ScreenRuntime({ document, host: { observers: [client.observer] } });
  runtime.emit({ type: 'screen_view', params: {} });
  runtime.emit({ type: 'error', kind: 'render', message: 'boom', nodeId: 'value' });
  await client.flush();
  await server.ctx.counters.flush();
  const rows = await server.ctx.db.query.telemetry.findMany();
  expect(rows.map((r) => `${r.type}:${r.subject}:${r.count}`).sort()).toEqual([
    'error:counter:1',
    'function:double:1',
    'screen_view:counter:1',
  ]);
});
