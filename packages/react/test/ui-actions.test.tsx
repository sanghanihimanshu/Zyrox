import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Document } from '@zyrox/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExampleRegistry } from '../../../examples/components/src/index';
import { useZyroxActions, type ZyroxActions, ZyroxProvider, ZyroxScreen } from '../src/index';
import { defaultOverlays } from '../src/overlays';
import { type UiActionSource, ZyroxRemote } from '../src/remote';

afterEach(cleanup);
const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

const promo: Document = {
  zyrox: 1,
  kind: 'screen',
  key: 'sheets/promo',
  params: { code: { type: 'string' } },
  root: {
    id: 'root',
    type: 'Stack',
    children: [
      { id: 'title', type: 'Text', props: { text: 'Use {{ params.code }}' } },
      {
        id: 'close',
        type: 'Button',
        props: { label: 'Got it' },
        on: { press: [{ do: 'closeSheet', result: 'ok' }] },
      },
    ],
  },
};

const home: Document = {
  zyrox: 1,
  kind: 'screen',
  key: 'home',
  state: { result: null, removed: false },
  root: {
    id: 'root',
    type: 'Stack',
    children: [
      {
        id: 'open',
        type: 'Button',
        props: { label: 'Open promo' },
        on: {
          press: [
            {
              do: 'sheet',
              screen: 'sheets/promo',
              params: { code: 'FIRST100' },
              title: 'Offer',
              onClose: [{ do: 'setState', path: 'result', value: '{{ event }}' }],
            },
          ],
        },
      },
      {
        id: 'remove',
        type: 'Button',
        props: { label: 'Remove' },
        on: {
          press: [
            {
              do: 'alert',
              title: 'Remove item?',
              buttons: [
                { label: 'Cancel', style: 'cancel' },
                {
                  label: 'Remove it',
                  style: 'destructive',
                  actions: [
                    { do: 'setState', path: 'removed', value: true },
                    {
                      do: 'toast',
                      message: 'Removed',
                      action: { label: 'Undo', actions: [{ do: 'setState', path: 'removed', value: false }] },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      {
        id: 'apply',
        type: 'Button',
        props: { label: 'Apply coupon' },
        on: { press: [{ do: 'request', url: '/coupons/apply', method: 'POST' }] },
      },
      { id: 'result', type: 'Text', props: { text: 'Result: {{ state.result }}' } },
      { id: 'removed', type: 'Text', if: '{{ state.removed }}', props: { text: 'Item removed' } },
    ],
  },
};

function App({
  fetcher,
  children,
  navigate = vi.fn(),
}: {
  fetcher?: (req: { url: string }) => Promise<unknown>;
  children?: React.ReactNode;
  navigate?: () => void;
}) {
  return (
    <ZyroxProvider
      registry={createExampleRegistry()}
      overlays={defaultOverlays}
      fetcher={fetcher}
      navigate={navigate}
      documents={{ 'sheets/promo': promo }}
    >
      <ZyroxScreen document={home} />
      {children}
    </ZyroxProvider>
  );
}

describe('overlays', () => {
  it('opens a sheet with a Zyrox screen and hands its result back', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Open promo' }));
    await flush();
    const dialog = screen.getByRole('dialog', { name: 'Offer' });
    expect(dialog.textContent).toContain('Use FIRST100');
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Result: ok')).toBeTruthy();
  });

  it('dismisses sheets with Escape', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Open promo' }));
    await flush();
    fireEvent.keyDown(window, { key: 'Escape' });
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('confirms with an alert and offers undo in a toast', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await flush();
    const alert = screen.getByRole('alertdialog', { name: 'Remove item?' });
    expect(alert).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove it' }));
    await flush();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText('Item removed')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Removed');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await flush();
    expect(screen.queryByText('Item removed')).toBeNull();
  });

  it('runs $actions from your API', async () => {
    const navigate = vi.fn();
    const fetcher = vi.fn(async () => ({
      ok: true,
      $actions: [
        { do: 'toast', message: 'FIRST100 applied', tone: 'success' },
        { do: 'navigate', to: 'cart', presentation: 'replace' },
      ],
    }));
    render(<App fetcher={fetcher} navigate={navigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply coupon' }));
    await flush();
    expect(screen.getByRole('status').textContent).toContain('FIRST100 applied');
    expect(navigate).toHaveBeenCalledWith('cart', {}, { presentation: 'replace' });
  });
});

describe('useZyroxActions', () => {
  it('opens overlays and handles backend responses from your own screens', async () => {
    let actions!: ZyroxActions;
    function Native() {
      actions = useZyroxActions();
      return null;
    }
    const events: string[] = [];
    render(
      <ZyroxProvider
        registry={createExampleRegistry()}
        overlays={defaultOverlays}
        observers={[(e) => events.push(`${e.type}:${e.screen}`)]}
      >
        <Native />
      </ZyroxProvider>,
    );
    await act(async () => {
      await actions.handle({
        data: 1,
        $actions: [{ do: 'sheet', content: { title: 'Hello {{ x }}', buttons: [{ label: 'OK' }] } }],
      });
    });
    expect(screen.getByRole('dialog').textContent).toContain('Hello {{ x }}');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => {
      await actions.toast('Saved');
    });
    expect(screen.getByRole('status').textContent).toContain('Saved');
    expect(await actions.handle([{ do: 'logout' }])).toBe(false);
    actions.screenView('cart', { total: 5 });
    actions.track('checkout');
    expect(events).toContain('screen_view:cart');
    expect(events).toContain('track:$app');
  });
});

describe('<ZyroxRemote>', () => {
  it('runs messages from sources and fires trigger rules on events', async () => {
    let push!: (message: unknown) => void;
    const source: UiActionSource = (receive) => {
      push = receive;
      return () => {};
    };
    const fetcher = vi.fn(async (req: { url: string }) => {
      if (req.url === '/ui/triggers')
        return {
          triggers: [
            {
              id: 'welcome',
              on: 'app_open',
              actions: [{ do: 'toast', message: 'Welcome back' }],
            },
            {
              id: 'promo',
              on: 'track',
              name: 'opened_promo',
              once: true,
              actions: [{ do: 'toast', message: 'Promo seen by {{ app.user }}' }],
            },
          ],
        };
      return {};
    });
    let actions!: ZyroxActions;
    function Native() {
      actions = useZyroxActions();
      return null;
    }
    render(
      <ZyroxProvider
        registry={createExampleRegistry()}
        overlays={defaultOverlays}
        fetcher={fetcher}
        app={{ user: 'Ada' }}
        storage={{ getItem: () => null, setItem: () => {}, removeItem: () => {} }}
      >
        <ZyroxRemote sources={[source]} triggers="/ui/triggers" />
        <Native />
      </ZyroxProvider>,
    );
    await flush();
    await flush();
    expect(screen.getByRole('status').textContent).toContain('Welcome back');
    await act(async () => {
      push(JSON.stringify({ id: 'm1', actions: [{ do: 'alert', title: 'Order shipped' }] }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByRole('alertdialog', { name: 'Order shipped' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    // The same message id again: ignored.
    await act(async () => {
      push({ id: 'm1', actions: [{ do: 'alert', title: 'Order shipped' }] });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    act(() => actions.track('opened_promo'));
    await flush();
    expect(screen.getByRole('status').textContent).toContain('Promo seen by Ada');
  });
});
