import type { Action, Document } from '@zyrox/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileActions } from '../src/compile';
import { OverlayController } from '../src/overlays';
import { createSseParser, pollSource, sseSource, UiActionCenter, webSocketSource } from '../src/remote';
import { DataCache, FetchError, type RuntimeHost, ScreenRuntime, type ZyroxEvent } from '../src/runtime';
import { parseUiMessage } from '../src/ui-message';
import { validateDocument } from '../src/validate';

const tick = () => new Promise((r) => setTimeout(r, 0));
const compile = (list: Action[]) => compileActions(list, []);

const doc = (partial: Partial<Document> = {}): Document => ({
  zyrox: 1,
  kind: 'screen',
  key: 'test',
  root: { id: 'root', type: 'Screen' },
  ...partial,
});

function setup(host: RuntimeHost = {}, document = doc()) {
  const overlays = new OverlayController();
  const events: ZyroxEvent[] = [];
  const navigate = vi.fn();
  const runtime = new ScreenRuntime({
    document,
    host: { overlays, navigate, observers: [(e) => events.push(e)], ...host },
  });
  return { runtime, overlays, events, navigate };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('OverlayController', () => {
  it('stacks sheets, replaces by id and resolves how they closed', async () => {
    const c = new OverlayController();
    const listener = vi.fn();
    c.subscribe(listener);
    const a = c.sheet({ id: 'promo', screen: 'a' });
    const b = c.sheet({ screen: 'b', content: { title: 'Hi', buttons: [] } });
    expect(c.getSnapshot().sheets.map((s) => s.screen)).toEqual(['a', 'b']);
    const a2 = c.sheet({ id: 'promo', screen: 'a2' });
    expect(await a).toEqual({ dismissed: true });
    expect(c.getSnapshot().sheets.map((s) => s.screen)).toEqual(['b', 'a2']);
    expect(c.closeSheet(undefined, { picked: 1 })).toBe(true);
    expect(await a2).toEqual({ result: { picked: 1 } });
    c.pressSheetButton(c.getSnapshot().sheets[0]!.key, 0);
    expect(await b).toEqual({ button: 0 });
    expect(c.closeSheet()).toBe(false);
    expect(listener).toHaveBeenCalled();
  });

  it('queues alerts and expires toasts', async () => {
    vi.useFakeTimers();
    const c = new OverlayController();
    const first = c.alert({ title: 'One', buttons: [] });
    const second = c.alert({ title: 'Two', buttons: [{ label: 'Yes', style: 'primary' }] });
    expect(c.getSnapshot().alerts[0]).toMatchObject({ title: 'One', buttons: [{ label: 'OK' }] });
    c.pressAlert(c.getSnapshot().alerts[0]!.key, 0);
    expect(await first).toBe(0);
    c.pressAlert(c.getSnapshot().alerts[0]!.key);
    expect(await second).toBeUndefined();

    const toast = c.toast({ message: 'Saved', duration: 2000 });
    const undo = c.toast({ message: 'Removed', action: { label: 'Undo' } });
    expect(c.getSnapshot().toasts.map((t) => [t.message, t.tone])).toEqual([
      ['Saved', 'info'],
      ['Removed', 'info'],
    ]);
    c.pressToast(c.getSnapshot().toasts[1]!.key);
    expect(await undo).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(await toast).toBe(false);
    expect(c.getSnapshot().toasts).toEqual([]);
    for (let i = 0; i < 5; i++) void c.toast({ message: `t${i}` });
    expect(c.getSnapshot().toasts.map((t) => t.message)).toEqual(['t2', 't3', 't4']);
    c.clear();
    expect(c.getSnapshot()).toEqual({ sheets: [], alerts: [], toasts: [] });
  });
});

describe('overlay actions', () => {
  it('opens sheets with content buttons and onClose', async () => {
    const { runtime, overlays } = setup({}, doc({ state: { picked: null, step: 0 } }));
    const ok = await runtime.run(
      compile([
        {
          do: 'sheet',
          title: 'Delivery',
          content: {
            title: 'Free delivery on {{ 2 + 1 }} items',
            buttons: [
              { label: 'Shop now', style: 'primary', actions: [{ do: 'setState', path: 'step', value: 1 }] },
              { label: 'Later', style: 'cancel' },
            ],
          },
          onClose: [{ do: 'setState', path: 'picked', value: '{{ event }}' }],
        },
        { do: 'setState', path: 'after', value: true },
      ]),
      null,
    );
    expect(ok).toBe(true);
    // Non-blocking: the list continued while the sheet is open.
    expect(runtime.getState('after')).toBe(true);
    const [sheet] = overlays.getSnapshot().sheets;
    expect(sheet).toMatchObject({
      title: 'Delivery',
      content: {
        title: 'Free delivery on 3 items',
        buttons: [
          { label: 'Shop now', style: 'primary' },
          { label: 'Later', style: 'cancel' },
        ],
      },
    });
    overlays.pressSheetButton(sheet!.key, 0);
    await tick();
    expect(runtime.getState('step')).toBe(1);

    await runtime.run(
      compile([
        {
          do: 'sheet',
          id: 'pick',
          screen: 'picker',
          onClose: [{ do: 'setState', path: 'picked', value: '{{ event }}' }],
        },
      ]),
      null,
    );
    await runtime.run(compile([{ do: 'closeSheet', id: 'pick', result: 'size-m' }]), null);
    await tick();
    expect(runtime.getState('picked')).toBe('size-m');
  });

  it('keeps an inline sheet document unevaluated', async () => {
    const { runtime, overlays } = setup({}, doc({ state: { name: 'caller' } }));
    const inline = doc({
      key: 'inline',
      state: { name: 'sheet' },
      root: { id: 'r', type: 'Text', props: { text: '{{ state.name }}' } },
    });
    await runtime.run(
      compile([{ do: 'sheet', document: inline, params: { from: '{{ state.name }}' } }]),
      null,
    );
    const [sheet] = overlays.getSnapshot().sheets;
    expect(sheet!.document).toBe(inline);
    expect(sheet!.params).toEqual({ from: 'caller' });
  });

  it('waits for alerts and runs the pressed button', async () => {
    const { runtime, overlays } = setup({}, doc({ state: { removed: false } }));
    const done = runtime.run(
      compile([
        {
          do: 'alert',
          title: 'Remove item?',
          buttons: [
            { label: 'Cancel', style: 'cancel' },
            {
              label: 'Remove',
              style: 'destructive',
              actions: [{ do: 'setState', path: 'removed', value: true }],
            },
          ],
        },
        { do: 'setState', path: 'after', value: true },
      ]),
      null,
    );
    await tick();
    expect(runtime.getState('after')).toBeUndefined();
    overlays.pressAlert(overlays.getSnapshot().alerts[0]!.key, 1);
    expect(await done).toBe(true);
    expect(runtime.getState('removed')).toBe(true);
    expect(runtime.getState('after')).toBe(true);
  });

  it('runs a toast action when pressed', async () => {
    const { runtime, overlays } = setup({}, doc({ state: { undone: false } }));
    await runtime.run(
      compile([
        {
          do: 'toast',
          message: 'Removed',
          tone: 'success',
          action: { label: 'Undo', actions: [{ do: 'setState', path: 'undone', value: true }] },
        },
      ]),
      null,
    );
    const [toast] = overlays.getSnapshot().toasts;
    expect(toast).toMatchObject({ message: 'Removed', tone: 'success', action: { label: 'Undo' } });
    overlays.pressToast(toast!.key);
    await tick();
    expect(runtime.getState('undone')).toBe(true);
  });

  it('reports a missing overlay host', async () => {
    const events: ZyroxEvent[] = [];
    const runtime = new ScreenRuntime({ document: doc(), host: { observers: [(e) => events.push(e)] } });
    expect(await runtime.run(compile([{ do: 'toast', message: 'x' }]), null)).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', message: expect.stringMatching(/No overlays/) }),
    );
  });

  it('validates overlay actions, nested buttons and inline documents', () => {
    const schema = validateDocument(
      doc({
        root: {
          id: 'root',
          type: 'Screen',
          on: { press: [{ do: 'sheet' } as Action, { do: 'toast' } as Action] },
        },
      }),
    ).map((p) => `${p.code} ${p.path} ${p.message}`);
    expect(schema).toEqual([
      'schema root.on.press.0 "sheet" needs "screen", "document" or "content"',
      'schema root.on.press.1.message "toast" needs "message"',
    ]);
    const problems = validateDocument(
      doc({
        root: {
          id: 'root',
          type: 'Screen',
          on: {
            press: [
              { do: 'sheet', screen: 'promo' },
              {
                do: 'alert',
                title: 'x',
                buttons: [{ label: 'Go', actions: [{ do: 'refresh', data: 'nope' }] }],
              },
              { do: 'toast', message: '{{ state. }}' },
              {
                do: 'sheet',
                document: {
                  zyrox: 1,
                  kind: 'screen',
                  key: 'x',
                  root: { id: 'r', type: 'T', props: { t: '{{ ) }}' } },
                },
              },
            ],
          },
        },
      }),
    );
    const messages = problems.map((p) => `${p.code} ${p.path}`);
    expect(messages).toContain('unknown_reference root.on.press.1.buttons.0.actions.0');
    expect(messages).toContainEqual(expect.stringMatching(/^expression root\.on\.press\.2/));
    expect(messages).toContainEqual(expect.stringMatching(/^expression root\.on\.press\.3\.document\.root/));
  });
});

describe('$actions from your backend', () => {
  it('runs $actions of responses, literally, and strips them from data', async () => {
    const fetcher = vi.fn(async () => ({
      items: [1],
      $actions: [
        { do: 'toast', message: 'Hi {{ app.secret }}' },
        { do: 'navigate', to: 'cart' },
      ],
    }));
    const { runtime, overlays, navigate } = setup(
      { fetcher, dataCache: new DataCache() },
      doc({ data: { feed: { url: '/feed', cache: 60 } } }),
    );
    runtime.start();
    await tick();
    await tick();
    expect(runtime.store.get('data.feed')).toEqual({ items: [1] });
    expect(overlays.getSnapshot().toasts[0]?.message).toBe('Hi {{ app.secret }}');
    expect(navigate).toHaveBeenCalledWith('cart', {}, { presentation: 'push' });
    runtime.stop();
  });

  it('runs $actions of error bodies and request results', async () => {
    const fetcher = vi.fn(async (req: { url: string }) => {
      if (req.url === '/me')
        throw new FetchError('Unauthorized', 401, {
          $actions: [{ do: 'navigate', to: 'login', presentation: 'reset' }],
        });
      return { ok: true, $actions: [{ do: 'toast', message: 'Coupon applied', tone: 'success' }] };
    });
    const { runtime, overlays, navigate } = setup({ fetcher }, doc({ state: { r: null, err: null } }));
    await runtime.run(compile([{ do: 'request', url: '/coupon', method: 'POST', into: 'r' }]), null);
    expect(runtime.getState('r')).toEqual({ ok: true });
    expect(overlays.getSnapshot().toasts[0]).toMatchObject({ message: 'Coupon applied', tone: 'success' });
    await runtime.run(
      compile([
        { do: 'request', url: '/me', onError: [{ do: 'setState', path: 'err', value: '{{ event.body }}' }] },
      ]),
      null,
    );
    await tick();
    expect(navigate).toHaveBeenCalledWith('login', {}, { presentation: 'reset' });
    expect(runtime.getState('err')).toEqual({});
  });

  it('rejects lists with actions outside remoteActions', async () => {
    const addToCart = vi.fn();
    const { runtime, events } = setup({ actions: { addToCart } });
    expect(
      await runtime.runRemote([
        { do: 'toast', message: 'x' },
        { do: 'addToCart', id: 1 },
      ]),
    ).toBe(false);
    expect(await runtime.runRemote([{ do: 'if', cond: true, then: [{ do: 'request', url: '/x' }] }])).toBe(
      false,
    );
    expect(await runtime.runRemote('nope')).toBe(false);
    expect(events.filter((e) => e.type === 'error').map((e) => (e as { message: string }).message)).toEqual([
      'Action "addToCart" is not allowed from a backend (add it to remoteActions)',
      'Action "request" is not allowed from a backend (add it to remoteActions)',
      'Backend actions must be a list of { do, … }',
    ]);
    expect(addToCart).not.toHaveBeenCalled();
    const allowed = setup({ actions: { addToCart }, remoteActions: ['addToCart'] });
    expect(await allowed.runtime.runRemote([{ do: 'addToCart', id: 1 }])).toBe(true);
    expect(addToCart).toHaveBeenCalledWith({ id: 1 }, expect.anything());
  });
});

describe('UI messages', () => {
  it('reads every shape a backend may send', () => {
    const actions = [{ do: 'toast', message: 'x' }];
    expect(parseUiMessage({ id: 'm1', actions })).toEqual({ id: 'm1', actions });
    expect(parseUiMessage({ data: 1, $actions: actions })).toEqual({ actions });
    expect(parseUiMessage(actions)).toEqual({ actions });
    expect(parseUiMessage({ zyrox: JSON.stringify({ id: 7, actions, expiresAt: 5 }) })).toEqual({
      id: '7',
      actions,
      expiresAt: 5,
    });
    expect(parseUiMessage(JSON.stringify({ triggers: [] }))).toEqual({ triggers: [] });
    expect(parseUiMessage('not json')).toBeUndefined();
    expect(parseUiMessage({ hello: 1 })).toBeUndefined();
  });
});

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe('UiActionCenter', () => {
  it('runs messages once per id and skips expired ones', async () => {
    const storage = memoryStorage();
    const { runtime, overlays } = setup();
    const center = new UiActionCenter({ runtime, storage });
    const message = { id: 'm1', actions: [{ do: 'toast', message: 'Order shipped' }] };
    await center.receive(message);
    await center.receive(JSON.stringify(message));
    await center.receive({ actions: [{ do: 'toast', message: 'late' }], expiresAt: '2000-01-01T00:00:00Z' });
    expect(overlays.getSnapshot().toasts.map((t) => t.message)).toEqual(['Order shipped']);
    // Remembered across launches.
    const again = setup();
    await new UiActionCenter({ runtime: again.runtime, storage }).receive(message);
    expect(again.overlays.getSnapshot().toasts).toEqual([]);
  });

  it('fires trigger rules on matching events, with conditions, limits and delays', async () => {
    let now = 1_000_000;
    const storage = memoryStorage();
    const { runtime, overlays } = setup({}, doc({ key: '$app' }));
    const center = new UiActionCenter({ runtime, storage, now: () => now });
    const event = (e: Partial<ZyroxEvent> & { type: string }) =>
      center.observer({ screen: 'home', time: now, ...e } as ZyroxEvent);
    center.setTriggers([
      {
        id: 'big-cart',
        on: 'track',
        name: 'add_to_cart',
        if: '{{ event.props.total >= 499 }}',
        cooldown: 60,
        actions: [{ do: 'toast', message: 'Free delivery unlocked on ₹{{ event.props.total }}' }],
      },
      {
        id: 'cart-tip',
        on: 'screen_view',
        name: 'cart',
        once: true,
        actions: [{ do: 'sheet', content: { title: 'Tip', buttons: [] } }],
      },
      { id: 'bad', on: 'track', if: '{{ ) }}', actions: [] },
      {
        id: 'later',
        on: 'screen_view',
        name: 'product',
        delay: 50,
        actions: [{ do: 'toast', message: 'Still deciding?' }],
      },
    ]);
    expect(center.getTriggers().map((t) => t.id)).toEqual(['big-cart', 'cart-tip', 'later']);

    await center.receive({ actions: [] }).catch(() => {});
    event({ type: 'track', name: 'add_to_cart', props: { total: 199 } });
    event({ type: 'track', name: 'add_to_cart', props: { total: 520 } });
    event({ type: 'track', name: 'add_to_cart', props: { total: 600 } });
    await tick();
    expect(overlays.getSnapshot().toasts.map((t) => t.message)).toEqual(['Free delivery unlocked on ₹520']);
    now += 61_000;
    event({ type: 'track', name: 'add_to_cart', props: { total: 600 } });
    await tick();
    expect(overlays.getSnapshot().toasts).toHaveLength(2);

    event({ type: 'screen_view', screen: 'cart', params: {} });
    event({ type: 'screen_view', screen: 'cart', params: {} });
    await tick();
    expect(overlays.getSnapshot().sheets).toHaveLength(1);
    expect(JSON.parse(storage.data.get('zyrox.ui')!).fired).toMatchObject({ 'cart-tip': expect.any(Number) });

    // Delayed: skipped when the user left the screen meanwhile.
    event({ type: 'screen_view', screen: 'product', params: {} });
    event({ type: 'screen_view', screen: 'home', params: {} });
    await new Promise((r) => setTimeout(r, 70));
    expect(overlays.getSnapshot().toasts.map((t) => t.message)).not.toContain('Still deciding?');
    event({ type: 'screen_view', screen: 'product', params: {} });
    await new Promise((r) => setTimeout(r, 70));
    expect(overlays.getSnapshot().toasts.map((t) => t.message)).toContain('Still deciding?');
    center.stop();
  });

  it('fires app_open once rules arrive and takes rules from messages', async () => {
    const { runtime, overlays } = setup();
    const center = new UiActionCenter({ runtime });
    center.appOpen();
    await center.receive({
      triggers: [{ id: 'hello', on: 'app_open', actions: [{ do: 'toast', message: 'Welcome back' }] }],
    });
    await tick();
    expect(overlays.getSnapshot().toasts.map((t) => t.message)).toEqual(['Welcome back']);
    center.appOpen();
    await tick();
    expect(overlays.getSnapshot().toasts).toHaveLength(1);
  });
});

describe('sources', () => {
  it('parses server-sent events across chunks', () => {
    const events: unknown[] = [];
    const retries: number[] = [];
    const feed = createSseParser(
      (e) => events.push(e),
      (ms) => retries.push(ms),
    );
    feed(': ping\n\nid: 1\ndata: {"actions":\n');
    feed('data: []}\n\nevent: other\ndata: x\n\nretry: 5000\r\ndata: last\r\n\r\n');
    expect(events).toEqual([
      { event: 'message', data: '{"actions":\n[]}', id: '1' },
      { event: 'other', data: 'x', id: '1' },
      { event: 'message', data: 'last', id: '1' },
    ]);
    expect(retries).toEqual([5000]);
  });

  it('streams over XHR with headers and reconnects with Last-Event-ID', async () => {
    const requests: FakeXhr[] = [];
    class FakeXhr {
      readyState = 0;
      responseText = '';
      withCredentials = false;
      headers: Record<string, string> = {};
      url = '';
      onprogress: (() => void) | null = null;
      onreadystatechange: (() => void) | null = null;
      aborted = false;
      open(_method: string, url: string) {
        this.url = url;
      }
      setRequestHeader(k: string, v: string) {
        this.headers[k] = v;
      }
      send() {
        requests.push(this);
      }
      abort() {
        this.aborted = true;
      }
      push(text: string) {
        this.responseText += text;
        this.readyState = 3;
        this.onreadystatechange?.();
      }
      end() {
        this.readyState = 4;
        this.onreadystatechange?.();
      }
    }
    const received: unknown[] = [];
    const stop = sseSource('/ui/events', {
      headers: () => ({ authorization: 'Bearer t' }),
      minDelay: 5,
      createRequest: () => new FakeXhr(),
    })((m) => received.push(m));
    await tick();
    expect(requests[0]).toMatchObject({
      url: '/ui/events',
      headers: { authorization: 'Bearer t', Accept: 'text/event-stream' },
    });
    requests[0]!.push('id: 41\ndata: {"actions":[]}\n\n');
    requests[0]!.end();
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toEqual(['{"actions":[]}']);
    expect(requests[1]?.headers['Last-Event-ID']).toBe('41');
    stop();
    expect(requests[1]!.aborted).toBe(true);
  });

  it('receives WebSocket messages and polls', async () => {
    const sockets: { onmessage?: (e: { data: unknown }) => void; close: () => void; onopen?: () => void }[] =
      [];
    const onOpen = vi.fn();
    const received: unknown[] = [];
    const stop = webSocketSource('wss://api.example.com/ui', {
      onOpen,
      createSocket: () => {
        const s = { close: vi.fn() };
        sockets.push(s);
        return s as unknown as WebSocket;
      },
    })((m) => received.push(m));
    sockets[0]!.onopen?.();
    sockets[0]!.onmessage?.({ data: '{"actions":[]}' });
    expect(onOpen).toHaveBeenCalled();
    expect(received).toEqual(['{"actions":[]}']);
    stop();
    expect(sockets[0]!.close).toHaveBeenCalled();

    const polled: unknown[] = [];
    const stopPoll = pollSource(
      async () => [
        { id: 'a', actions: [] },
        { id: 'b', actions: [] },
      ],
      { interval: 60 },
    )((m) => polled.push(m));
    await tick();
    expect(polled).toEqual([
      { id: 'a', actions: [] },
      { id: 'b', actions: [] },
    ]);
    stopPoll();
  });
});

describe('@zyrox/actions compatibility', () => {
  it('runs what the backend SDK builds', async () => {
    const { ui, withActions, uiMessage, toPushData, trigger } = await import('../../actions/src');
    const { runtime, overlays, navigate } = setup({}, doc({ key: '$app' }));
    const response = withActions({ ok: true }, ui.toast('Saved', { tone: 'success' }), ui.redirect('orders'));
    expect(await runtime.runRemote(parseUiMessage(response)!.actions)).toBe(true);
    expect(overlays.getSnapshot().toasts[0]).toMatchObject({ message: 'Saved', tone: 'success' });
    expect(navigate).toHaveBeenCalledWith('orders', {}, { presentation: 'replace' });

    const center = new UiActionCenter({ runtime });
    await center.receive(
      toPushData(
        uiMessage([ui.message({ title: 'Order shipped', buttons: [ui.button('Track')] })], { id: 'p1' }),
      ),
    );
    expect(overlays.getSnapshot().sheets[0]?.content?.title).toBe('Order shipped');
    // Backend and app meet as JSON; the SDK types an inline document loosely.
    const rules = [
      trigger({ id: 't', on: 'track', name: 'buy', actions: [ui.toast('{{ event.props.n }} items')] }),
    ];
    center.setTriggers(JSON.parse(JSON.stringify(rules)));
    center.observer({ type: 'track', name: 'buy', props: { n: 3 }, screen: 'x', time: 0 });
    await tick();
    expect(overlays.getSnapshot().toasts.map((t) => t.message)).toContain('3 items');
  });
});
