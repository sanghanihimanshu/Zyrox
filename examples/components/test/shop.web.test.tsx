import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type Fetcher, ZyroxProvider, ZyroxScreen } from '@wishyor/zyrox-react';
import { handleShopRequest } from '@zyrox-examples/shop-api';
import { useMemo, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { documents } from '../documents';
import { createExampleRegistry } from '../src/index';

afterEach(cleanup);
const wait = (ms = 0) => act(() => new Promise((r) => setTimeout(r, ms)));

/** The app: owns the cart and calls its own backend; Zyrox renders the feed. */
function Shop({ fetcher, navigate }: { fetcher: Fetcher; navigate: () => void }) {
  const [cart, setCart] = useState<{ count: number; total: number; items: Record<string, number> }>({
    count: 0,
    total: 0,
    items: {},
  });
  const registry = useMemo(
    () =>
      createExampleRegistry({
        addToCart: (id, qty, price = 0) =>
          setCart((c) => ({
            count: c.count + qty,
            total: c.total + qty * price,
            items: { ...c.items, [id]: (c.items[id] ?? 0) + qty },
          })),
      }),
    [],
  );
  return (
    <ZyroxProvider
      registry={registry}
      fetcher={fetcher}
      navigate={navigate}
      documents={documents}
      app={{ cart }}
    >
      <ZyroxScreen screen="shop-home" />
    </ZyroxProvider>
  );
}

describe('shop feed against the example backend', () => {
  it('renders backend sections, fetches each rail lazily, updates the cart and searches', async () => {
    const fetcher = vi.fn<Fetcher>((req) =>
      handleShopRequest({ method: req.method, url: req.url, body: req.body }),
    );
    render(<Shop fetcher={fetcher} navigate={vi.fn()} />);
    await wait();
    await wait();
    // Static sections come inline with the feed; rails call their own API.
    expect(screen.getByText('Delivery in 10 minutes')).toBeTruthy();
    expect(screen.getByText('Festive store is live')).toBeTruthy();
    expect(screen.getAllByText('Shimla Apple').length).toBeGreaterThan(0);
    const urls = fetcher.mock.calls.map(([req]) => req.url);
    expect(urls[0]).toBe('/feed/home?segment=');
    expect(urls).toContain('/collections/bestsellers');
    expect(urls.some((u) => u === '/collections/daily' || u === '/collections/under99')).toBe(true);
    // The "stories" section is unknown to this app build and is skipped.
    expect(screen.queryByText('stories')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: 'Add Shimla Apple' })[0]!);
    await wait();
    expect(screen.getAllByLabelText('1 in cart').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /1 item · ₹129(\.00)? · View cart/ })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'mil' } });
    await wait(350);
    await wait();
    expect(screen.getByText('Results for “mil”')).toBeTruthy();
    expect(screen.getAllByText('Toned Milk').length).toBeGreaterThan(0);
    expect(fetcher.mock.calls.map(([req]) => req.url)).toContain('/search?q=mil');
  }, 15_000);
});
