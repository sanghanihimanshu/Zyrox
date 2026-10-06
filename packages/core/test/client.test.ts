import type { Document } from '@zyrox/protocol';
import { describe, expect, it, vi } from 'vitest';
import { type Bootstrap, type ClientStorage, ZyroxClient } from '../src/client';

const doc = (key: string): Document => ({ zyrox: 1, kind: 'screen', key, root: { id: 'r', type: 'Screen' } });

function memoryStorage(): ClientStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => {
      data.set(k, v);
    },
    removeItem: async (k) => {
      data.delete(k);
    },
  };
}

function server(bootstrap: Bootstrap, docs: Record<string, Document>, extra: Record<string, unknown> = {}) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/v1/bootstrap') return json(bootstrap);
    if (path.startsWith('/v1/docs/')) {
      const d = docs[decodeURIComponent(path.slice('/v1/docs/'.length))];
      return d ? json(d) : json({ error: { message: 'nope' } }, 404);
    }
    if (path.startsWith('/v1/strings/')) return json(extra[path] ?? {}, extra[path] ? 200 : 404);
    if (path.startsWith('/v1/functions/')) {
      const body = JSON.parse(String(init?.body));
      return path.endsWith('/fail')
        ? json({ error: { message: 'Function failed' } }, 500)
        : json({ result: { echo: body.args } });
    }
    if (path === '/v1/telemetry') return json({ ok: true });
    return json({}, 404);
  });
}

const base = {
  endpoint: 'https://ui.example.com/',
  publicKey: 'pk_test',
  manifestHash: 'm_1',
  platform: 'web',
  telemetryInterval: 0,
  retryDelayMs: 1,
};

describe('ZyroxClient', () => {
  it('bootstraps, prefetches immutable documents and caches them', async () => {
    const bootstrap: Bootstrap = { ttl: 60, docs: { home: 'ref-home' }, experiments: [] };
    const fetch = server(bootstrap, { 'ref-home': doc('home') });
    const storage = memoryStorage();
    const client = new ZyroxClient({
      ...base,
      storage,
      fetch,
      attrs: { country: 'IN' },
      appVersion: '1.2.3',
      locales: () => ['fr-FR'],
    });
    expect(client.getDocument('home')).toEqual({ status: 'loading' });
    await client.refresh();
    expect(client.getDocument('home')).toMatchObject({ status: 'ready', ref: 'ref-home', source: 'network' });
    expect(client.getDocument('other')).toEqual({ status: 'missing' });
    const [, init] = fetch.mock.calls[0]!;
    const headers = init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer pk_test');
    expect(headers['x-zyrox-client']).toBe('platform=web; app=1.2.3; manifest=m_1; protocol=1');
    expect(headers['x-zyrox-attrs']).toBe('country=IN');
    expect(headers['x-zyrox-user']).toMatch(/^anon_/);
    expect(headers['accept-language']).toBe('fr-FR');

    // A second client (next app launch) works offline from storage.
    const offline = new ZyroxClient({
      ...base,
      storage,
      fetch: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    await offline.ready();
    expect(offline.getUser()).toBe(client.getUser());
    expect(offline.getDocument('home')).toEqual({ status: 'loading' });
    await offline.loadDocument('ref-home');
    expect(offline.getDocument('home')).toMatchObject({ status: 'ready', source: 'cache' });
    await expect(offline.refresh(true)).rejects.toThrow('offline');
  });

  it('respects the TTL and uses a snapshot before the network', async () => {
    const fetch = server({ ttl: 3600, docs: { home: 'ref-2' }, experiments: [] }, { 'ref-2': doc('home') });
    const client = new ZyroxClient({
      ...base,
      fetch,
      snapshot: {
        bootstrap: { ttl: 0, docs: { home: 'ref-1' }, experiments: [] },
        docs: { 'ref-1': doc('home') },
      },
    });
    expect(client.getDocument('home')).toMatchObject({ status: 'ready', ref: 'ref-1', source: 'snapshot' });
    await client.refresh();
    expect(client.getDocument('home')).toMatchObject({ ref: 'ref-2' });
    await client.refresh();
    expect(fetch.mock.calls.filter(([u]) => String(u).endsWith('/v1/bootstrap'))).toHaveLength(1);
  });

  it('reports failed documents', async () => {
    const client = new ZyroxClient({
      ...base,
      fetch: server({ ttl: 60, docs: { home: 'gone' }, experiments: [] }, {}),
    });
    await client.refresh();
    expect(client.getDocument('home')).toMatchObject({ status: 'error' });
  });

  it('loads strings, calls functions and flushes aggregated telemetry', async () => {
    const fetch = server(
      { ttl: 60, docs: {}, strings: { defaultLocale: 'en', refs: { fr: 's-fr' } }, experiments: [] },
      {},
      { '/v1/strings/s-fr': { zyrox: 1, kind: 'strings', locale: 'fr', messages: { hi: 'Salut' } } },
    );
    const client = new ZyroxClient({ ...base, fetch });
    await client.refresh();
    expect(client.locales()).toEqual(['fr']);
    expect(await client.loadStrings('fr')).toEqual({ hi: 'Salut' });
    expect(await client.loadStrings('de')).toBeNull();
    expect(await client.callFunction('quote', { a: 1 }, { screen: 's' })).toEqual({ echo: { a: 1 } });
    await expect(client.callFunction('fail', {}, { screen: 's' })).rejects.toThrow('Function failed');

    const base2 = { screen: 'home', version: 'r1', time: 1 };
    client.observer({ ...base2, type: 'screen_view', params: {} });
    client.observer({ ...base2, type: 'screen_view', params: {} });
    client.observer({ ...base2, type: 'error', kind: 'render', message: 'x', nodeId: 'n' });
    client.observer({ ...base2, type: 'track', name: 'ignored', props: {} });
    await client.flush();
    const call = fetch.mock.calls.find(([u]) => String(u).endsWith('/v1/telemetry'))!;
    expect(JSON.parse(String(call[1]!.body)).events).toEqual([
      { type: 'screen_view', screen: 'home', version: 'r1', count: 2 },
      { type: 'error', screen: 'home', version: 'r1', kind: 'render', nodeId: 'n', message: 'x', count: 1 },
    ]);
    client.dispose();
  });

  it('hydrates synchronously from sync storage so cached screens render on the first frame', async () => {
    const storage = syncStorage();
    const fetch = server(
      { ttl: 60, docs: { home: 'ref-home' }, experiments: [] },
      { 'ref-home': doc('home') },
    );
    await new ZyroxClient({ ...base, storage, fetch }).refresh();
    const next = new ZyroxClient({ ...base, storage, fetch: vi.fn() });
    // No await: the very first getDocument call is ready.
    expect(next.getDocument('home')).toMatchObject({ status: 'ready', source: 'cache', ref: 'ref-home' });
  });

  it('revalidates the bootstrap with an ETag', async () => {
    const etags: (string | undefined)[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/docs/ref-home') return new Response(JSON.stringify(doc('home')));
      const sent = (init!.headers as Record<string, string>)['if-none-match'];
      etags.push(sent);
      if (sent === '"b_1"') return new Response(null, { status: 304 });
      return new Response(JSON.stringify({ ttl: 0, docs: { home: 'ref-home' }, experiments: [] }), {
        headers: { etag: '"b_1"' },
      });
    });
    const client = new ZyroxClient({ ...base, fetch });
    await client.refresh();
    await client.refresh();
    expect(etags).toEqual([undefined, '"b_1"']);
    expect(client.getDocument('home')).toMatchObject({ status: 'ready', ref: 'ref-home' });
  });

  it('retries flaky requests and times out hung ones', async () => {
    let calls = 0;
    const flaky = vi.fn(async () => {
      calls++;
      if (calls < 3) return new Response('busy', { status: 503 });
      return new Response(JSON.stringify({ ttl: 60, docs: {}, experiments: [] }));
    });
    const client = new ZyroxClient({ ...base, fetch: flaky });
    await client.refresh();
    expect(calls).toBe(3);

    const hung = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    const slow = new ZyroxClient({ ...base, fetch: hung, timeoutMs: 20, retries: 1 });
    await expect(slow.refresh()).rejects.toThrow('Request timed out: /v1/bootstrap');
    expect(hung).toHaveBeenCalledTimes(2);
  });

  it('keeps showing the previous version until the new one downloads, then prunes it', async () => {
    const storage = memoryStorage();
    let bootstrap: Bootstrap = { ttl: 0, docs: { home: 'v1', about: 'a1' }, experiments: [] };
    const docs: Record<string, Document> = { v1: doc('home'), a1: doc('about') };
    let docsUp = true;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/bootstrap') return new Response(JSON.stringify(bootstrap));
      const d = docs[path.slice('/v1/docs/'.length)];
      if (!docsUp) throw new Error('offline');
      return d ? new Response(JSON.stringify(d)) : new Response('{}', { status: 404 });
    });
    const client = new ZyroxClient({ ...base, storage, fetch });
    await client.refresh();
    expect([...storage.data.keys()].filter((k) => k.startsWith('zyrox:doc:'))).toEqual([
      'zyrox:doc:v1',
      'zyrox:doc:a1',
    ]);

    // v2 is released but can't be downloaded (flaky network): the app keeps rendering v1.
    bootstrap = { ttl: 0, docs: { home: 'v2' }, experiments: [] };
    docs.v2 = { ...doc('home'), title: 'New' };
    docsUp = false;
    await client.refresh();
    expect(client.getDocument('home')).toMatchObject({ status: 'ready', ref: 'v1', stale: true });
    expect(storage.data.has('zyrox:doc:v1')).toBe(true);
    expect(storage.data.has('zyrox:doc:a1')).toBe(false); // no longer released

    docsUp = true;
    await client.refresh();
    expect(client.getDocument('home')).toMatchObject({ status: 'ready', ref: 'v2', source: 'network' });
    expect(client.getDocument('home')).not.toHaveProperty('stale');
    expect([...storage.data.keys()].filter((k) => k.startsWith('zyrox:doc:'))).toEqual(['zyrox:doc:v2']);
    expect(JSON.parse(storage.data.get('zyrox:index')!)).toEqual(['zyrox:doc:v2']);
  });

  it('prefetches all, none or chosen documents, a few at a time', async () => {
    const docs = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`r${i}`, doc(`d${i}`)]));
    const bootstrap: Bootstrap = {
      ttl: 60,
      docs: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`d${i}`, `r${i}`])),
      experiments: [],
    };
    let active = 0;
    let peak = 0;
    const inner = server(bootstrap, docs);
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return inner(url, init);
    });
    const all = new ZyroxClient({ ...base, fetch });
    await all.refresh();
    expect(fetch).toHaveBeenCalledTimes(11);
    expect(peak).toBeLessThanOrEqual(4);

    const some = new ZyroxClient({ ...base, fetch: server(bootstrap, docs), prefetch: ['d1', 'nope'] });
    await some.refresh();
    expect(some.getDocument('d1')).toMatchObject({ status: 'ready' });
    const none = server(bootstrap, docs);
    await new ZyroxClient({ ...base, fetch: none, prefetch: 'none' }).refresh();
    expect(none).toHaveBeenCalledTimes(1);
  });

  it('retries failed documents after a cooldown', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      let up = false;
      const inner = server({ ttl: 60, docs: { home: 'r' }, experiments: [] }, { r: doc('home') });
      const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes('/v1/docs/') && !up) throw new Error('offline');
        return inner(url, init);
      });
      const client = new ZyroxClient({ ...base, fetch, retries: 0 });
      await client.refresh();
      expect(client.getDocument('home')).toMatchObject({ status: 'error' });
      up = true;
      expect(client.getDocument('home')).toMatchObject({ status: 'error' });
      vi.setSystemTime(Date.now() + 11_000);
      expect(client.getDocument('home')).toEqual({ status: 'loading' });
      await client.loadDocument('r');
      expect(client.getDocument('home')).toMatchObject({ status: 'ready' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('batches runtime translations and keeps them until the source strings change', async () => {
    const requests: unknown[] = [];
    const storage = memoryStorage();
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/bootstrap')
        return new Response(
          JSON.stringify({
            ttl: 60,
            docs: {},
            strings: { defaultLocale: 'en', refs: { en: 's_en' }, translate: true },
            experiments: [],
          }),
        );
      if (path === '/v1/translate') {
        const body = JSON.parse(String(init?.body)) as { keys: string[] };
        requests.push(body);
        return new Response(
          JSON.stringify({ messages: Object.fromEntries(body.keys.map((k) => [k, `fr:${k}`])) }),
        );
      }
      return new Response('{}', { status: 404 });
    });
    const client = new ZyroxClient({ ...base, fetch, storage });
    await client.refresh();
    const ask = (key: string) =>
      client.translateMissing({ key, locale: 'fr', source: key, sourceLocale: 'en' });
    expect(await Promise.all([ask('hi'), ask('bye'), ask('hi')])).toEqual(['fr:hi', 'fr:bye', 'fr:hi']);
    expect(requests).toEqual([{ locale: 'fr', keys: ['hi', 'bye'] }]);
    expect(
      await client.translateMissing({ key: 'x', locale: 'en', source: 'x', sourceLocale: 'en' }),
    ).toBeNull();

    const next = new ZyroxClient({ ...base, fetch, storage });
    await next.refresh();
    expect(await next.translateMissing({ key: 'bye', locale: 'fr', source: 'bye', sourceLocale: 'en' })).toBe(
      'fr:bye',
    );
    expect(requests).toHaveLength(1);
  });

  it('sends the app user token with remote function calls only', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ result: 1 })));
    const client = new ZyroxClient({ ...base, fetch, userToken: async () => 'jwt-123' });
    await client.callFunction('quote', {}, { screen: 's' });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-zyrox-user-token']).toBe('jwt-123');
  });

  it('keeps telemetry when the network is down', async () => {
    let up = false;
    const sent: unknown[] = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (!up) throw new Error('offline');
      sent.push(JSON.parse(String(init?.body)));
      return new Response('{}');
    });
    const client = new ZyroxClient({ ...base, fetch });
    const view = { type: 'screen_view' as const, screen: 'home', version: 'r', time: 1, params: {} };
    client.observer(view);
    await client.flush();
    client.observer(view);
    up = true;
    await client.flush();
    expect(sent).toEqual([{ events: [{ type: 'screen_view', screen: 'home', version: 'r', count: 2 }] }]);
  });
});

function syncStorage(): ClientStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

describe('draft previews and SSR', () => {
  it('sends the preview token, skips storage and telemetry', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify({ ttl: 60, docs: {}, preview: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
    const client = new ZyroxClient({
      endpoint: 'https://ui.example.com',
      publicKey: 'pk_dev_x',
      manifestHash: 'm',
      platform: 'web',
      previewToken: 'zpv_abc.def',
      storage,
      fetch: fetchFn,
      telemetryInterval: 0,
    });
    await client.refresh(true);
    expect(calls[0]!.headers['x-zyrox-preview']).toBe('zpv_abc.def');
    expect(storage.setItem).not.toHaveBeenCalled();
    client.observer({ type: 'screen_view', screen: 'home', params: {}, time: 0 });
    await client.flush();
    expect(calls.filter((c) => c.url.endsWith('/v1/telemetry'))).toEqual([]);
  });

  it('fetches one screen for server rendering', async () => {
    const { fetchScreen } = await import('../src/ssr');
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: init?.headers as Record<string, string> });
      if (url.endsWith('/missing')) return new Response('{}', { status: 404 });
      if (url.endsWith('/broken'))
        return new Response(JSON.stringify({ error: { message: 'Unknown public key' } }), { status: 401 });
      return new Response(JSON.stringify({ key: 'sections/sale', ref: 'd_1', document: { zyrox: 1 } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const base = { endpoint: 'https://ui.example.com/', publicKey: 'pk_prod_x', fetch: fetchFn };
    const screen = await fetchScreen({
      ...base,
      screen: 'sections/sale',
      user: 'u1',
      locale: ['fr-FR', 'en'],
      attrs: { plan: 'pro' },
    });
    expect(screen).toMatchObject({ key: 'sections/sale', ref: 'd_1' });
    expect(seen[0]!.url).toBe('https://ui.example.com/v1/screens/sections/sale');
    expect(seen[0]!.headers).toMatchObject({
      authorization: 'Bearer pk_prod_x',
      'x-zyrox-user': 'u1',
      'x-zyrox-attrs': 'plan=pro',
      'accept-language': 'fr-FR, en',
    });
    expect(seen[0]!.headers['x-zyrox-client']).toContain('platform=web');
    expect(await fetchScreen({ ...base, screen: 'missing' })).toBeNull();
    await expect(fetchScreen({ ...base, screen: 'broken' })).rejects.toThrow('Unknown public key');
  });
});
