import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Document } from '@zyrox/protocol';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import counterJson from '../../../examples/components/documents/counter.json';
import homeJson from '../../../examples/components/documents/home.json';
import productJson from '../../../examples/components/documents/product.json';
import signupJson from '../../../examples/components/documents/signup.json';
import { TextDef } from '../../../examples/components/src/defs';
import { createExampleRegistry, exampleStrings, webComponents } from '../../../examples/components/src/index';
import {
  createRegistry,
  definePlugin,
  extendComponent,
  implement,
  type MotionAdapter,
  type Registry,
  useI18n,
  type ZyroxEvent,
  ZyroxProvider,
  type ZyroxProviderProps,
  ZyroxScreen,
  z,
} from '../src/index';
import { defaultOverlays } from '../src/overlays';

const counter = counterJson as unknown as Document;
const product = productJson as unknown as Document;
const signup = signupJson as unknown as Document;
const home = homeJson as unknown as Document;

afterEach(cleanup);

function setup(
  document: Document,
  options: Partial<ZyroxProviderProps> & { registry?: Registry; params?: Record<string, unknown> } = {},
) {
  const events: ZyroxEvent[] = [];
  const { registry = createExampleRegistry(), params, ...rest } = options;
  const utils = render(
    <ZyroxProvider registry={registry} observers={[(e) => events.push(e)]} {...rest}>
      <ZyroxScreen document={document} params={params} />
    </ZyroxProvider>,
  );
  return { ...utils, events };
}

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

describe('ZyroxScreen', () => {
  it('renders and updates the counter', async () => {
    const { events } = setup(counter);
    expect(screen.getByRole('heading', { name: 'Counter' })).toBeTruthy();
    expect(screen.getByText('Count: 0')).toBeTruthy();
    expect((screen.getByLabelText('Decrease') as HTMLButtonElement).disabled).toBe(true);
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByLabelText('Increase'));
    await flush();
    expect(screen.getByText('Count: 3')).toBeTruthy();
    expect(screen.getByText("That's a lot")).toBeTruthy();
    expect((screen.getByLabelText('Decrease') as HTMLButtonElement).disabled).toBe(false);
    expect(events.find((e) => e.type === 'screen_view')).toMatchObject({ screen: 'counter' });
    expect(events.filter((e) => e.type === 'action' && e.action === 'setState')).toHaveLength(3);
  });

  it('renders the product page with mocks, fallbacks, bindings, templates and host actions', async () => {
    const addToCart = vi.fn();
    const navigate = vi.fn();
    const { events } = setup(product, {
      registry: createExampleRegistry({ addToCart }),
      overlays: defaultOverlays,
      mock: true,
      navigate,
      params: { id: 'p1' },
    });
    expect(screen.getAllByRole('heading', { name: 'Trail Shoe' })).toHaveLength(2);
    expect((screen.getByAltText('Trail Shoe') as HTMLImageElement).src).toContain('picsum.photos');
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', kind: 'unknown_component', nodeId: 'gallery' }),
    );
    expect(screen.getByText('$129.50')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Increase quantity'));
    await flush();
    expect(screen.getByText('$259.00')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Gift wrap' }));
    await flush();
    expect((screen.getByRole('switch', { name: 'Gift wrap' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 to cart' }));
    await flush();
    expect(addToCart).toHaveBeenCalledWith('p1', 2);
    expect(screen.getByRole('status').textContent).toContain('Added to cart');
    expect(events.find((e) => e.type === 'track')).toMatchObject({
      name: 'add_to_cart',
      props: { productId: 'p1', qty: 2, giftWrap: true },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cap' }));
    await flush();
    expect(navigate).toHaveBeenCalledWith('product', { id: 'p3' }, { presentation: 'push' });
  });

  it('binds form fields, validates the declared form and submits', async () => {
    const fetcher = vi.fn(async () => ({ name: 'Ada' }));
    const navigate = vi.fn();
    setup(signup, { fetcher, navigate });
    const submit = screen.getByRole('button', { name: 'Create account' });
    // Required fields are marked; no errors before the user does anything.
    expect(screen.getByLabelText('Email').getAttribute('aria-required')).toBe('true');
    expect(screen.queryByRole('alert')).toBeNull();
    // Pressing submit runs `validate`: every error shows and the request never starts.
    fireEvent.click(submit);
    await flush();
    expect(screen.getAllByRole('alert').map((a) => a.textContent)).toEqual([
      'Enter your name',
      'Enter your email',
    ]);
    expect(screen.getByText('Accept the terms to continue')).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada' } });
    await flush();
    expect(screen.getByRole('alert').textContent).toBe('Enter a valid email');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.click(screen.getByRole('switch', { name: 'I accept the terms' }));
    await flush();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(submit);
    await flush();
    expect(fetcher).toHaveBeenCalledWith(
      expect.objectContaining({
        url: '/signup',
        method: 'POST',
        body: { name: 'Ada', email: 'ada@example.com', terms: true },
      }),
    );
    expect(navigate).toHaveBeenCalledWith('welcome', { name: 'Ada' }, { presentation: 'push' });
  });

  it('shows a field error after blur, and API field errors until the field changes', async () => {
    const fetcher = vi.fn(async () => {
      throw Object.assign(new Error('Invalid'), {
        status: 422,
        body: { errors: { email: 'Already registered' } },
      });
    });
    setup(signup, { fetcher });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada' } });
    await flush();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.blur(screen.getByLabelText('Email'));
    await flush();
    expect(screen.getByRole('alert').textContent).toBe('Enter a valid email');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'taken@example.com' } });
    fireEvent.click(screen.getByRole('switch', { name: 'I accept the terms' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await flush();
    expect(screen.getByRole('alert').textContent).toBe('Already registered');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'taken2@example.com' } });
    await flush();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders repeats, with-scopes, translations and switches language at runtime', async () => {
    let switchTo: ((l: string) => Promise<void>) | undefined;
    function LanguageSwitch() {
      const i18n = useI18n();
      switchTo = i18n.setLocale;
      return <span data-testid="locale">{i18n.locale}</span>;
    }
    render(
      <ZyroxProvider
        registry={createExampleRegistry()}
        mock
        strings={exampleStrings}
        defaultLocale="en"
        locale="en"
        app={{ user: { name: 'Ada' } }}
      >
        <LanguageSwitch />
        <ZyroxScreen document={home} />
      </ZyroxProvider>,
    );
    expect(screen.getByRole('heading', { name: 'Home' })).toBeTruthy();
    expect(screen.getByText('Good morning, Ada')).toBeTruthy();
    expect(screen.getByText('Free shipping')).toBeTruthy();
    expect(screen.getByText('20% off caps')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sock' })).toBeTruthy();
    expect(screen.getByAltText('Sock')).toBeTruthy();
    await act(() => switchTo!('fr'));
    expect(screen.getByRole('heading', { name: 'Accueil' })).toBeTruthy();
    expect(screen.getByTestId('locale').textContent).toBe('fr');
  });

  it('re-renders only the nodes that read changed state', async () => {
    const renders: Record<string, number> = {};
    const CountingText = implement(TextDef, ({ text, nodeId }) => {
      renders[nodeId] = (renders[nodeId] ?? 0) + 1;
      return <p>{String(text)}</p>;
    });
    const registry = createRegistry({
      components: [...webComponents.filter((c) => c.def.name !== 'Text'), CountingText],
    });
    const doc: Document = {
      zyrox: 1,
      kind: 'screen',
      key: 'perf',
      state: { a: 0, b: 0 },
      root: {
        id: 'root',
        type: 'Stack',
        children: [
          { id: 'a', type: 'Text', props: { text: 'a={{ state.a }}' } },
          { id: 'b', type: 'Text', props: { text: 'b={{ state.b }}' } },
          { id: 'static', type: 'Text', props: { text: 'static' } },
          {
            id: 'inc',
            type: 'Button',
            props: { label: 'inc a' },
            on: { press: [{ do: 'setState', path: 'a', value: '{{ state.a + 1 }}' }] },
          },
        ],
      },
    };
    setup(doc, { registry });
    const before = { ...renders };
    fireEvent.click(screen.getByRole('button', { name: 'inc a' }));
    await flush();
    expect(screen.getByText('a=1')).toBeTruthy();
    expect(renders.a).toBe(before.a! + 1);
    expect(renders.b).toBe(before.b);
    expect(renders.static).toBe(before.static);
  });

  it('isolates render errors and reports unknown components', async () => {
    const Broken = implement(extendComponent(TextDef, { name: 'Broken' }), () => {
      throw new Error('kaboom');
    });
    const registry = createRegistry({ components: [...webComponents, Broken] });
    const doc: Document = {
      zyrox: 1,
      kind: 'screen',
      key: 'errors',
      root: {
        id: 'root',
        type: 'Stack',
        children: [
          {
            id: 'broken',
            type: 'Broken',
            props: { text: 'x' },
            fallback: { id: 'fb', type: 'Text', props: { text: 'Fallback shown' } },
          },
          { id: 'missing', type: 'Nope' },
          { id: 'ok', type: 'Text', props: { text: 'Still here' } },
        ],
      },
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { events } = setup(doc, { registry });
    spy.mockRestore();
    expect(screen.getByText('Fallback shown')).toBeTruthy();
    expect(screen.getByText('Still here')).toBeTruthy();
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', kind: 'render', nodeId: 'broken', message: 'kaboom' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', kind: 'unknown_component', nodeId: 'missing' }),
    );
  });

  it('passes motion to the adapter and fires lifecycle events', async () => {
    const seen: { nodeId: string; visible: boolean }[] = [];
    const motion: MotionAdapter = {
      presets: ['fade'],
      Item: ({ nodeId, visible, children }: { nodeId: string; visible: boolean; children?: ReactNode }) => {
        seen.push({ nodeId, visible });
        return <>{children}</>;
      },
    };
    const doc: Document = {
      zyrox: 1,
      kind: 'screen',
      key: 'motion',
      state: { show: true, appeared: 0 },
      root: {
        id: 'root',
        type: 'Stack',
        on: { appear: [{ do: 'setState', path: 'appeared', value: '{{ state.appeared + 1 }}' }] },
        children: [
          {
            id: 'banner',
            type: 'Text',
            if: '{{ state.show }}',
            motion: { enter: 'fade', exit: 'fade' },
            props: { text: 'Banner' },
          },
          { id: 'n', type: 'Text', props: { text: 'appeared {{ state.appeared }}' } },
          {
            id: 'hide',
            type: 'Button',
            props: { label: 'hide' },
            on: { press: [{ do: 'setState', path: 'show', value: false }] },
          },
        ],
      },
    };
    setup(doc, { registry: createRegistry({ components: webComponents, motion }) });
    await flush();
    expect(screen.getByText('appeared 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'hide' }));
    await flush();
    expect(screen.queryByText('Banner')).toBeNull();
    expect(seen.at(-1)).toEqual({ nodeId: 'banner', visible: false });
  });
});

describe('registry', () => {
  it('merges plugins, lets the app override them and builds a manifest', () => {
    const LoudText = implement(TextDef, ({ text }) => <b>{String(text)}</b>);
    const observer = vi.fn();
    const plugin = definePlugin({
      name: 'analytics',
      observers: [observer],
      helpers: { shout: (s: string) => `${s}!` },
      components: [LoudText],
      transitions: ['zoom'],
    });
    const registry = createRegistry({ plugins: [plugin], components: webComponents, transitions: ['slide'] });
    expect(registry.components.get('Text')!.Component).not.toBe(LoudText.Component);
    expect(registry.observers).toEqual([observer]);
    expect(registry.manifest.helpers).toEqual(['shout']);
    expect(registry.manifest.transitions).toEqual(['slide', 'zoom']);
    expect(Object.keys(registry.manifest.components)).toContain('List');
    const custom = createRegistry({
      components: [
        implement(
          extendComponent(TextDef, { name: 'Price', props: { currency: z.string() } }),
          ({ text, currency }) => <span>{`${currency}${text}`}</span>,
        ),
      ],
    });
    expect(custom.manifest.components.Price!.props.required).toEqual(['text', 'currency']);
  });
});
