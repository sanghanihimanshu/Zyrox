import type { Document } from '@zyrox/protocol';
import { describe, expect, it, vi } from 'vitest';
import counterJson from '../../../examples/components/documents/counter.json';
import signupJson from '../../../examples/components/documents/signup.json';
import { compileDocument } from '../src/compile';
import {
  childFrame,
  DataCache,
  FetchError,
  type RuntimeHost,
  ScreenRuntime,
  type ZyroxEvent,
} from '../src/runtime';

const counter = counterJson as unknown as Document;
const signup = signupJson as unknown as Document;

const tick = () => new Promise((r) => setTimeout(r, 0));

function screen(doc: Document, host: RuntimeHost = {}, params?: Record<string, unknown>) {
  const events: ZyroxEvent[] = [];
  const runtime = new ScreenRuntime({
    document: doc,
    params,
    host: { ...host, observers: [(e) => events.push(e)] },
  });
  return { runtime, events, compiled: compileDocument(doc) };
}

function doc(partial: Partial<Document> & Pick<Document, 'root'>): Document {
  return { zyrox: 1, kind: 'screen', key: 'test', ...partial };
}

describe('ScreenRuntime actions', () => {
  it('runs setState actions from the counter document', async () => {
    const { runtime, compiled } = screen(counter);
    const inc = compiled.nodes.get('inc')!;
    await runtime.run(inc.on.press, null);
    await runtime.run(inc.on.press, null);
    expect(runtime.getState('count')).toBe(2);
    const label = runtime.evaluate(compiled.nodes.get('value')!.props, null) as { text: string };
    expect(label.text).toBe('Count: 2');
  });

  it('submits the signup form with request/onSuccess/into', async () => {
    const navigate = vi.fn();
    const fetcher = vi.fn(async () => ({ name: 'Ada' }));
    const { runtime, compiled, events } = screen(signup, {
      fetcher,
      navigate,
      apiBaseUrl: 'https://api.example.com/v1/',
    });
    runtime.setState('form', { name: 'Ada', email: 'ada@example.com', terms: true });
    const ok = await runtime.run(compiled.nodes.get('submit')!.on.press, null);
    expect(ok).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.example.com/v1/signup',
        method: 'POST',
        body: { name: 'Ada', email: 'ada@example.com', terms: true },
        source: 'request',
      }),
    );
    expect(runtime.getState('result')).toEqual({ name: 'Ada' });
    expect(runtime.getState('submitting')).toBe(false);
    expect(navigate).toHaveBeenCalledWith('welcome', { name: 'Ada' }, { presentation: 'push' });
    expect(events.find((e) => e.type === 'track')).toMatchObject({ name: 'signup', screen: 'signup' });
  });

  it('runs onError with the error as event', async () => {
    const fetcher = vi.fn(async () => {
      throw new FetchError('Email taken', 409);
    });
    const { runtime, compiled } = screen(signup, { fetcher });
    runtime.setState('form', { name: 'Ada', email: 'ada@example.com', terms: true });
    await runtime.run(compiled.nodes.get('submit')!.on.press, null);
    expect(runtime.getState('error')).toBe('Email taken');
    expect(runtime.getState('submitting')).toBe(false);
  });

  it('stops a list on an unhandled error and reports it', async () => {
    const d = doc({
      root: {
        id: 'b',
        type: 'Button',
        on: { press: [{ do: 'explode' }, { do: 'setState', path: 'after', value: true }] },
      },
    });
    const { runtime, compiled, events } = screen(d);
    expect(await runtime.run(compiled.root.on.press, null)).toBe(false);
    expect(runtime.getState('after')).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', kind: 'action', message: 'Unknown action "explode"' }),
    );
  });

  it('calls host actions with evaluated args and a context', async () => {
    const addToCart = vi.fn(
      async (_args: Record<string, unknown>, ctx: { setState: (p: string, v: unknown) => void }) => {
        ctx.setState('added', true);
      },
    );
    const d = doc({
      state: { qty: 2 },
      root: {
        id: 'b',
        type: 'Button',
        on: { press: [{ do: 'addToCart', productId: '{{ event.id }}', qty: '{{ state.qty }}' }] },
      },
    });
    const { runtime, compiled } = screen(d, { actions: { addToCart } });
    await runtime.run(compiled.root.on.press, null, { id: 'p1' }, 'b');
    expect(addToCart.mock.calls[0]![0]).toEqual({ productId: 'p1', qty: 2 });
    expect(runtime.getState('added')).toBe(true);
  });

  it('supports if, navigate options, back, openUrl and track', async () => {
    const navigate = vi.fn();
    const back = vi.fn();
    const openUrl = vi.fn();
    const d = doc({
      state: { ok: true },
      root: {
        id: 'b',
        type: 'Button',
        on: {
          press: [
            {
              do: 'if',
              cond: '{{ state.ok }}',
              then: [
                {
                  do: 'navigate',
                  to: 'details',
                  params: { id: 1 },
                  presentation: 'modal',
                  transition: 'slide',
                },
              ],
              else: [{ do: 'back' }],
            },
            { do: 'openUrl', url: 'https://example.com' },
          ],
        },
      },
    });
    const { runtime, compiled } = screen(d, { navigate, back, openUrl });
    await runtime.run(compiled.root.on.press, null);
    expect(navigate).toHaveBeenCalledWith(
      'details',
      { id: 1 },
      { presentation: 'modal', transition: 'slide' },
    );
    expect(back).not.toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledWith('https://example.com');
  });

  it('refuses unsafe URLs', async () => {
    const openUrl = vi.fn();
    const fetcher = vi.fn(async () => ({}));
    const d = doc({
      root: {
        id: 'b',
        type: 'Button',
        on: {
          a: [{ do: 'openUrl', url: 'javascript:alert(1)' }],
          b: [{ do: 'request', url: 'https://evil.example.com/steal' }],
          c: [{ do: 'request', url: '//evil.example.com/x' }],
          d: [{ do: 'request', url: 'https://api.example.com/ok' }],
        },
      },
    });
    const { runtime, compiled } = screen(d, { openUrl, fetcher, apiBaseUrl: 'https://api.example.com' });
    expect(await runtime.run(compiled.root.on.a, null)).toBe(false);
    expect(await runtime.run(compiled.root.on.b, null)).toBe(false);
    expect(await runtime.run(compiled.root.on.c, null)).toBe(false);
    expect(await runtime.run(compiled.root.on.d, null)).toBe(true);
    expect(openUrl).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('ScreenRuntime scope', () => {
  it('resolves frames, roots and params with defaults', () => {
    const d = doc({
      params: { id: { type: 'string', required: true }, tab: { type: 'string', default: 'info' } },
      root: { id: 'r', type: 'X' },
    });
    const { runtime, events } = screen(d, {}, {});
    expect(runtime.lookup('params', null)).toEqual({ tab: 'info' });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', message: 'Missing required param "id"' }),
    );
    const frame = childFrame(childFrame(null, { item: { a: 1 } }), { index: 3 });
    expect(runtime.lookup('item', frame)).toEqual({ a: 1 });
    expect(runtime.lookup('index', frame)).toBe(3);
  });

  it('reports expression errors once', () => {
    const d = doc({ root: { id: 'r', type: 'X', props: { a: '{{ nope() }}' } } });
    const { runtime, compiled, events } = screen(d);
    runtime.evaluate(compiled.root.props, null, undefined, 'r');
    runtime.evaluate(compiled.root.props, null, undefined, 'r');
    expect(events.filter((e) => e.type === 'error' && e.kind === 'expression')).toHaveLength(1);
  });

  it('only tracks store roots that are not shadowed', () => {
    const d = doc({ root: { id: 'r', type: 'X' } });
    const { runtime } = screen(d);
    const tracked: string[] = [];
    const frame = childFrame(null, { state: { local: true }, item: { x: 1 } });
    const value = runtime.evaluate(
      {
        k: 'e',
        ast: { t: 'mem', obj: { t: 'id', name: 'item' }, prop: { t: 'lit', v: 'x' }, computed: false },
        src: '',
      },
      frame,
      (p) => tracked.push(p),
    );
    expect(value).toBe(1);
    runtime.evaluate({ k: 'e', ast: { t: 'id', name: 'state' }, src: '' }, frame, (p) => tracked.push(p));
    runtime.evaluate({ k: 'e', ast: { t: 'id', name: 'data' }, src: '' }, frame, (p) => tracked.push(p));
    expect(tracked).toEqual(['data']);
  });
});

describe('ScreenRuntime data sources', () => {
  it('fetches on mount and refetches when inputs change', async () => {
    const fetcher = vi.fn(async (req: { url: string }) => ({ url: req.url }));
    const d = doc({
      state: { q: 'a' },
      data: { results: { url: '/search?q={{ state.q }}' } },
      root: { id: 'r', type: 'X' },
    });
    const { runtime, events } = screen(d, { fetcher });
    runtime.start();
    expect(runtime.store.get('loading.results')).toBe(true);
    await tick();
    expect(runtime.store.get('data.results')).toEqual({ url: '/search?q=a' });
    expect(runtime.store.get('loading.results')).toBe(false);
    runtime.setState('q', 'b');
    await tick();
    expect(runtime.store.get('data.results')).toEqual({ url: '/search?q=b' });
    runtime.setState('unrelated', 1);
    await tick();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === 'data_load')).toHaveLength(2);
    runtime.stop();
  });

  it('shares cached responses between screens (stale-while-revalidate)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      let n = 0;
      const fetcher = vi.fn(async () => ({ n: ++n }));
      const dataCache = new DataCache();
      const d = doc({
        data: { feed: { url: '/feed', cache: 60 }, live: { url: '/live' } },
        root: { id: 'r', type: 'X' },
      });
      const first = screen(d, { fetcher, dataCache });
      first.runtime.start();
      await tick();
      expect(first.runtime.store.get('data.feed')).toEqual({ n: 1 });
      first.runtime.stop();

      // Reopening the screen within 60 s: instant, no request for the cached source.
      const second = screen(d, { fetcher, dataCache });
      second.runtime.start();
      expect(second.runtime.store.get('data.feed')).toEqual({ n: 1 });
      expect(second.runtime.store.get('loading.feed')).toBe(false);
      await tick();
      expect(fetcher.mock.calls.map((c) => (c as unknown as [{ url: string }])[0].url)).toEqual([
        '/feed',
        '/live',
        '/live',
      ]);
      expect(second.events.find((e) => e.type === 'data_load' && e.key === 'feed')).toMatchObject({
        cached: true,
      });
      second.runtime.stop();

      // After 60 s: the old response shows immediately while a fresh one loads.
      vi.setSystemTime(Date.now() + 61_000);
      const third = screen(d, { fetcher, dataCache });
      third.runtime.start();
      expect(third.runtime.store.get('data.feed')).toEqual({ n: 1 });
      expect(third.runtime.store.get('loading.feed')).toBe(true);
      await tick();
      expect(third.runtime.store.get('data.feed')).toMatchObject({ n: expect.any(Number) });
      expect((third.runtime.store.get('data.feed') as { n: number }).n).toBeGreaterThan(1);
      third.runtime.stop();
      dataCache.clear();
      expect(dataCache.get(JSON.stringify({}))).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('debounces, waits for `if`, and chains sources', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async (req: { url: string; key?: string }) =>
        req.key === 'user' ? { id: 7 } : { url: req.url },
      );
      const d = doc({
        state: { q: '' },
        data: {
          user: { url: '/me' },
          orders: { url: '/users/{{ data.user.id }}/orders', if: '{{ data.user.id }}' },
          search: { url: '/s?q={{ state.q }}', if: '{{ len(state.q) > 1 }}', debounce: 300 },
        },
        root: { id: 'r', type: 'X' },
      });
      const { runtime } = screen(d, { fetcher });
      runtime.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher.mock.calls.map((c) => c[0].url)).toEqual(['/me', '/users/7/orders']);
      runtime.setState('q', 'a');
      runtime.setState('q', 'ab');
      runtime.setState('q', 'abc');
      await vi.advanceTimersByTimeAsync(299);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetcher.mock.calls.map((c) => c[0].url)).toEqual(['/me', '/users/7/orders', '/s?q=abc']);
      runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('records errors, ignores stale responses and supports refresh', async () => {
    let fail = true;
    const fetcher = vi.fn(async () => {
      if (fail) throw new FetchError('Down', 503);
      return { ok: true };
    });
    const d = doc({ data: { feed: { url: '/feed' } }, root: { id: 'r', type: 'X' } });
    const { runtime, events } = screen(d, { fetcher });
    runtime.start();
    await tick();
    expect(runtime.store.get('error.feed')).toMatchObject({ message: 'Down', status: 503 });
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', kind: 'data' }));
    fail = false;
    await runtime.refresh('feed');
    expect(runtime.store.get('data.feed')).toEqual({ ok: true });
    expect(runtime.store.get('error.feed')).toBeNull();
    await expect(runtime.refresh('nope')).rejects.toThrow(/Unknown data source/);
    runtime.stop();
  });

  it('uses mocks in mock mode and polls with intervals', async () => {
    const d = doc({ data: { feed: { url: '/feed', mock: { items: [1] } } }, root: { id: 'r', type: 'X' } });
    const fetcher = vi.fn();
    const { runtime } = screen(d, { mock: true, fetcher });
    runtime.start();
    expect(runtime.store.get('data.feed')).toEqual({ items: [1] });
    expect(fetcher).not.toHaveBeenCalled();

    vi.useFakeTimers();
    try {
      const poll = vi.fn(async () => ({}));
      const p = screen(
        doc({ data: { live: { url: '/live', refresh: [5] } }, root: { id: 'r', type: 'X' } }),
        { fetcher: poll },
      );
      p.runtime.start();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(poll).toHaveBeenCalledTimes(2);
      p.runtime.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(poll).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes on foreground', async () => {
    let listener: (() => void) | undefined;
    const fetcher = vi.fn(async () => ({}));
    const d = doc({
      data: { feed: { url: '/feed', refresh: ['mount', 'foreground'] } },
      root: { id: 'r', type: 'X' },
    });
    const { runtime } = screen(d, {
      fetcher,
      onForeground: (l) => {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
    });
    runtime.start();
    await tick();
    listener!();
    await tick();
    expect(fetcher).toHaveBeenCalledTimes(2);
    runtime.stop();
    expect(listener).toBeUndefined();
  });
});

describe('ScreenRuntime lifecycle', () => {
  it('can be stopped and started again (React StrictMode)', async () => {
    const fetcher = vi.fn(async () => ({ n: 1 }));
    const d = doc({ data: { feed: { url: '/feed' } }, root: { id: 'r', type: 'X' } });
    const { runtime } = screen(d, { fetcher });
    runtime.start();
    runtime.stop();
    runtime.start();
    await tick();
    expect(runtime.store.get('data.feed')).toEqual({ n: 1 });
    expect(runtime.store.get('loading.feed')).toBe(false);
    runtime.stop();
    runtime.stop();
  });
});
