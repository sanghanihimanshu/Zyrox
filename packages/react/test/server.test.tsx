import { act, cleanup, render, screen } from '@testing-library/react';
import { ZyroxClient } from '@zyrox/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import counterJson from '../../../examples/components/documents/counter.json';
import { createExampleRegistry } from '../../../examples/components/src/index';
import { type ZyroxEvent, ZyroxProvider, ZyroxScreen } from '../src/index';

afterEach(cleanup);

describe('server delivery', () => {
  it('loads a screen by key, reports exposure and calls remote functions', async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      const body =
        path === '/v1/bootstrap'
          ? {
              ttl: 60,
              docs: { counter: 'ref-c' },
              experiments: [{ key: 'exp', variant: 'b', docs: ['counter'] }],
            }
          : path === '/v1/docs/ref-c'
            ? counterJson
            : {};
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const client = new ZyroxClient({
      endpoint: 'https://ui.test',
      publicKey: 'pk',
      manifestHash: 'm',
      platform: 'web',
      fetch,
      telemetryInterval: 0,
    });
    const events: ZyroxEvent[] = [];
    render(
      <ZyroxProvider registry={createExampleRegistry()} client={client} observers={[(e) => events.push(e)]}>
        <ZyroxScreen screen="counter" loading={<p>Loading…</p>} />
      </ZyroxProvider>,
    );
    expect(screen.getByText('Loading…')).toBeTruthy();
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(screen.getByText('Count: 0')).toBeTruthy();
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'exposure', experiment: 'exp', variant: 'b', version: 'ref-c' }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'screen_load', source: 'network' }));
  });

  it('shows the fallback when there is no such screen', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ttl: 60, docs: {}, experiments: [] })));
    const client = new ZyroxClient({
      endpoint: 'https://ui.test',
      publicKey: 'pk',
      manifestHash: 'm',
      platform: 'web',
      fetch,
      telemetryInterval: 0,
    });
    render(
      <ZyroxProvider registry={createExampleRegistry()} client={client}>
        <ZyroxScreen screen="nope" fallback={<p>Not available</p>} />
      </ZyroxProvider>,
    );
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(screen.getByText('Not available')).toBeTruthy();
  });

  it('falls back to documents bundled with the app', async () => {
    const counter = counterJson as unknown as import('@zyrox/protocol').Document;
    const local = render(
      <ZyroxProvider registry={createExampleRegistry()} documents={{ counter }}>
        <ZyroxScreen screen="counter" />
        <ZyroxScreen screen="other" fallback={<p>No such screen</p>} />
      </ZyroxProvider>,
    );
    expect(screen.getByText('Count: 0')).toBeTruthy();
    expect(screen.getByText('No such screen')).toBeTruthy();
    local.unmount();

    // With a server that hasn't released this screen, the bundled one shows; events say so.
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ttl: 60, docs: {}, experiments: [] })));
    const client = new ZyroxClient({
      endpoint: 'https://ui.test',
      publicKey: 'pk',
      manifestHash: 'm',
      platform: 'web',
      fetch,
      telemetryInterval: 0,
    });
    const events: ZyroxEvent[] = [];
    render(
      <ZyroxProvider
        registry={createExampleRegistry()}
        client={client}
        documents={{ counter }}
        observers={[(e) => events.push(e)]}
      >
        <ZyroxScreen screen="counter" />
      </ZyroxProvider>,
    );
    await act(() => client.refresh());
    expect(screen.getByText('Count: 0')).toBeTruthy();
    expect(events.find((e) => e.type === 'screen_load')).toMatchObject({ source: 'bundled' });
  });
});
