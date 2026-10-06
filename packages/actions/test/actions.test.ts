import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Validator } from '@cfworker/json-schema';
import { describe, expect, it } from 'vitest';
import {
  assertUiActions,
  encodeSse,
  toPushData,
  trigger,
  UiChannel,
  type UiMessage,
  ui,
  uiJsonSchema,
  uiMessage,
  validateUiActions,
  validateUiMessage,
  validateUiTriggers,
  withActions,
} from '../src';

const schema = new Validator(uiJsonSchema as never, '2020-12', false);

describe('builders', () => {
  it('build plain JSON actions', () => {
    const actions = [
      ui.redirect('cart'),
      ui.reset('login', { reason: 'expired' }),
      ui.message(
        {
          title: 'Free delivery',
          message: 'On orders over ₹499',
          buttons: [ui.button('Shop now', [ui.navigate('offers')], 'primary')],
        },
        { id: 'promo' },
      ),
      ui.sheet({ screen: 'sheets/address', params: { mode: 'edit' }, size: 'half' }),
      ui.confirm('Cancel order?', 'You will get a refund.', {
        label: 'Cancel order',
        destructive: true,
        actions: [ui.action('cancelOrder', { id: 'o1' })],
      }),
      ui.toast('Coupon applied', {
        tone: 'success',
        action: { label: 'Undo', actions: [ui.refresh('cart')] },
      }),
      ui.track('promo_shown', { id: 'promo' }),
      ui.setErrors('account', { email: 'Already registered' }),
      ui.closeSheet('promo'),
      ui.back(),
      ui.openUrl('https://example.com/help'),
    ];
    expect(actions[0]).toEqual({ do: 'navigate', to: 'cart', presentation: 'replace' });
    expect(actions[4]).toMatchObject({
      do: 'alert',
      buttons: [
        { label: 'Cancel', style: 'cancel' },
        { label: 'Cancel order', style: 'destructive', actions: [{ do: 'cancelOrder', id: 'o1' }] },
      ],
    });
    expect(validateUiActions(actions)).toEqual([]);
    expect(() => assertUiActions(actions)).not.toThrow();
    expect(schema.validate(actions).valid).toBe(true);
    expect(JSON.parse(JSON.stringify(actions))).toEqual(actions);
  });

  it('attach actions to responses and build messages', () => {
    const body = withActions({ ok: true, total: 520 }, ui.toast('Saved'), [ui.refresh()]);
    expect(body).toEqual({
      ok: true,
      total: 520,
      $actions: [{ do: 'toast', message: 'Saved' }, { do: 'refresh' }],
    });
    expect(withActions(body, ui.back()).$actions).toHaveLength(3);
    const message = uiMessage([ui.toast('Order shipped')], { id: 'o1-shipped', expiresIn: 60 });
    expect(message.id).toBe('o1-shipped');
    expect(Date.parse(String(message.expiresAt))).toBeGreaterThan(Date.now());
    const rules = [
      trigger({
        id: 'big-cart',
        on: 'track',
        name: 'add_to_cart',
        if: '{{ event.props.total >= 499 }}',
        cooldown: 3600,
        actions: [ui.toast('Free delivery unlocked')],
      }),
    ];
    expect(validateUiMessage(uiMessage([], { triggers: rules }))).toEqual([]);
    expect(schema.validate({ triggers: rules }).valid).toBe(true);
  });
});

describe('validation', () => {
  it('reports problems with paths', () => {
    expect(
      validateUiActions([
        { do: 'navigate' },
        { do: 'sheet' },
        { do: 'alert', title: 'x', buttons: [{ label: 'Go', style: 'loud', actions: [{ nope: 1 }] }] },
        { do: 'toast', message: 'x', tone: 'pink' },
        { do: 'sheet', document: { key: 'x' } },
        { do: 'if', cond: true, then: [{ do: 'openUrl' }] },
      ]),
    ).toEqual([
      { path: '0', message: '"navigate" needs "to"' },
      { path: '1', message: '"sheet" needs "screen", "document" or "content"' },
      { path: '2.buttons.0.style', message: 'style must be one of default, primary, cancel, destructive' },
      { path: '2.buttons.0.actions.0', message: 'An action is an object with "do"' },
      { path: '3.tone', message: 'tone must be one of info, success, warning, danger' },
      { path: '4.document', message: 'Expected a Zyrox document { zyrox: 1, kind, key, root }' },
      { path: '5.then.0', message: '"openUrl" needs "url"' },
    ]);
    expect(validateUiActions('x')).toEqual([{ path: '', message: 'Expected a list of actions' }]);
    expect(() => assertUiActions([{ do: 'toast' }])).toThrow(/0: "toast" needs "message"/);
    expect(
      validateUiTriggers([
        { id: 'a', on: 'track', actions: [] },
        { id: 'a', on: 'tap', cooldown: -1, actions: [] },
      ]),
    ).toEqual([
      { path: '1', message: 'Duplicate trigger id "a"' },
      { path: '1.on', message: 'on must be one of screen_view, track, app_open, foreground' },
      { path: '1.cooldown', message: 'cooldown must be a number ≥ 0' },
    ]);
    expect(validateUiMessage({})).toEqual([{ path: '', message: 'A message needs "actions" or "triggers"' }]);
    expect(schema.validate([{ do: 'sheet' }]).valid).toBe(false);
    expect(schema.validate([{ do: 'toast' }]).valid).toBe(false);
    expect(schema.validate([{ do: 'addToCart', id: 1 }]).valid).toBe(true);
  });

  it('ships the JSON Schema as a file', () => {
    const file = JSON.parse(readFileSync(resolve(import.meta.dirname, '../ui-actions.schema.json'), 'utf8'));
    expect(file).toEqual(JSON.parse(JSON.stringify(uiJsonSchema)));
  });
});

async function readFrames(response: Response, count: number): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (text.split('\n\n').filter(Boolean).length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  await reader.cancel();
  return text.split('\n\n').filter(Boolean);
}

describe('UiChannel', () => {
  it('publishes to subscribers by key and broadcasts', () => {
    const channel = new UiChannel();
    const got: [string, UiMessage][] = [];
    const stop = channel.subscribe('user-1', (m, id) => got.push([id, m]));
    channel.subscribe('user-2', () => {});
    channel.publish('user-1', [ui.toast('Hi')]);
    channel.publish(['user-2'], { actions: [ui.toast('Other')] });
    channel.broadcast(uiMessage([ui.toast('Everyone')]));
    expect(got.map(([, m]) => m.actions?.[0])).toEqual([
      { do: 'toast', message: 'Hi' },
      { do: 'toast', message: 'Everyone' },
    ]);
    expect(got[0]![0]).toMatch(/^[a-z0-9]+-1$/);
    expect(channel.connections()).toBe(2);
    stop();
    expect(channel.connections('user-1')).toBe(0);
  });

  it('serves server-sent events with replay after Last-Event-ID', async () => {
    const channel = new UiChannel({ heartbeatMs: 60_000 });
    const first = channel.publish('u', [ui.toast('one')]);
    channel.publish('u', [ui.toast('two')]);
    channel.broadcast([ui.toast('all')]);
    channel.publish('someone-else', [ui.toast('nope')]);
    const response = channel.sse('u', { headers: new Headers({ 'last-event-id': first }) });
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const pending = readFrames(response, 4);
    await new Promise((r) => setTimeout(r, 0));
    channel.publish('u', [ui.toast('live')]);
    const frames = await pending;
    expect(frames[0]).toBe('retry: 3000');
    expect(frames.slice(1).map((f) => JSON.parse(f.split('data: ')[1]!).actions[0].message)).toEqual([
      'two',
      'all',
      'live',
    ]);
    await new Promise((r) => setTimeout(r, 0));
    expect(channel.connections('u')).toBe(0);
    expect(channel.replay('u', 'other-process-1')).toEqual([]);
  });

  it('pipes to Node responses', () => {
    const channel = new UiChannel({ heartbeatMs: 60_000 });
    const written: string[] = [];
    let onClose = () => {};
    const res = {
      writeHead: (status: number) => written.push(`HTTP ${status}`),
      write: (c: string) => written.push(c),
    };
    channel.pipe('u', { headers: {}, on: (_e, fn) => (onClose = fn) }, res);
    channel.publish('u', [ui.toast('hello')]);
    expect(written[0]).toBe('HTTP 200');
    expect(written.at(-1)).toMatch(
      /^id: .+\ndata: \{"actions":\[\{"do":"toast","message":"hello"\}\]\}\n\n$/,
    );
    onClose();
    expect(channel.connections()).toBe(0);
  });

  it('encodes frames', () => {
    expect(encodeSse({ actions: [] }, '7')).toBe('id: 7\ndata: {"actions":[]}\n\n');
  });
});

describe('push', () => {
  it('fits messages into push data', () => {
    expect(toPushData([ui.toast('Shipped')])).toEqual({
      zyrox: '{"actions":[{"do":"toast","message":"Shipped"}]}',
    });
    expect(() => toPushData([ui.toast('x'.repeat(5000))])).toThrow(/about 4 KB/);
  });
});
