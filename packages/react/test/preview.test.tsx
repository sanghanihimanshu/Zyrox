import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Document } from '@wishyor/zyrox-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { placeholderRegistry } from '../../../apps/dashboard/src/preview/placeholders';
import counterJson from '../../../examples/components/documents/counter.json';
import { createExampleRegistry } from '../../../examples/components/src/index';
import { ZyroxProvider } from '../src/index';
import { parsePreviewLink, ZyroxPreviewHost } from '../src/preview';

const counter = counterJson as unknown as Document;
afterEach(cleanup);

describe('parsePreviewLink', () => {
  it('reads app-scheme and https links', () => {
    expect(
      parsePreviewLink('myapp://zyrox-preview?server=https%3A%2F%2Fui.example.com&session=prv_1&token=abc'),
    ).toEqual({
      server: 'https://ui.example.com',
      session: 'prv_1',
      token: 'abc',
    });
    expect(
      parsePreviewLink(
        'https://app.example.com/?zyrox-preview=1&server=http%3A%2F%2Flocalhost%3A4400&session=s&token=t',
      ),
    ).toMatchObject({ session: 's' });
    expect(parsePreviewLink('myapp://product?id=1')).toBeNull();
  });
});

describe('placeholderRegistry', () => {
  it('includes a Screen fallback when no project manifest is available', () => {
    const registry = placeholderRegistry(undefined);
    expect(registry.components.get('Screen')).toBeDefined();
    expect(registry.manifest.components.Screen).toBeDefined();
  });
});

describe('ZyroxPreviewHost', () => {
  it('renders documents sent by the dashboard and turns clicks into selection', async () => {
    const posted: unknown[] = [];
    const spy = vi.spyOn(window, 'postMessage').mockImplementation((data: unknown) => {
      posted.push(data);
    });
    render(
      <ZyroxProvider registry={createExampleRegistry()}>
        <ZyroxPreviewHost allowedOrigins={['http://dashboard']} placeholder={<p>Waiting…</p>} />
      </ZyroxProvider>,
    );
    expect(screen.getByText('Waiting…')).toBeTruthy();
    expect(posted[0]).toMatchObject({
      type: 'zyrox:ready',
      manifest: { hash: expect.stringMatching(/^m_/) },
    });
    // Other sites can't drive the frame.
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'zyrox:render', document: counter, mode: 'select' },
          origin: 'https://evil.example',
          source: window,
        }),
      );
    });
    expect(screen.queryByText('Count: 0')).toBeNull();
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'zyrox:render', document: counter, mode: 'select' },
          origin: 'http://dashboard',
          source: window,
        }),
      );
    });
    expect(screen.getByText('Count: 0')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Increase'));
    expect(screen.getByText('Count: 0')).toBeTruthy();
    expect(posted.at(-1)).toEqual({ type: 'zyrox:select', nodeId: 'inc' });

    const edited = { ...counter, root: { ...counter.root, props: { title: 'Edited title' } } };
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'zyrox:render', document: edited, mode: 'interact' },
          origin: 'http://dashboard',
          source: window,
        }),
      );
    });
    expect(screen.getByRole('heading', { name: 'Edited title' })).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Increase'));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(screen.getByText('Count: 1')).toBeTruthy();
    expect(
      posted.some((m) => (m as { type: string; event?: { type: string } }).event?.type === 'action'),
    ).toBe(true);
    spy.mockRestore();
  });
});
