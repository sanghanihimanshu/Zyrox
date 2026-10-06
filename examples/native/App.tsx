import {
  type Fetcher,
  type NavigateOptions,
  type Observer,
  useI18n,
  useZyroxActions,
  ZyroxProvider,
  ZyroxScreen,
} from '@wishyor/zyrox-react';
import { defaultOverlays } from '@wishyor/zyrox-react/overlays';
import { type PreviewLink, parsePreviewLink, ZyroxLivePreview } from '@wishyor/zyrox-react/preview';
import { sseSource, type UiActionSource, ZyroxRemote } from '@wishyor/zyrox-react/remote';
import { createExampleRegistry, exampleStrings } from '@zyrox-examples/components';
import { documents } from '@zyrox-examples/components/documents';
import { handleShopRequest, orderUpdate, products, shopEvents } from '@zyrox-examples/shop-api';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import { Linking, Modal, Pressable, SafeAreaView, Text, View } from 'react-native';

// Point at your Zyrox server to load published screens; leave empty to render the bundled documents.
const endpoint = process.env.EXPO_PUBLIC_ZYROX_ENDPOINT;
const publicKey = process.env.EXPO_PUBLIC_ZYROX_KEY;
const local = !endpoint;
/** Your own backend's URL; without it the example shop runs in-process. */
const shopApi = process.env.EXPO_PUBLIC_SHOP_API;
/**
 * UI your backend pushes (order updates…): server-sent events from the shop API, or the same
 * channel in-process. Push notifications work the same way: pass their data to a source.
 */
const uiEvents: UiActionSource = shopApi
  ? sseSource(`${shopApi.replace(/\/$/, '')}/ui/events?user=demo`)
  : (receive) => shopEvents.subscribe('demo', receive);

/** Older demo screens that run on their data source mocks. */
const mocked = new Set(['home', 'product']);

interface Entry {
  screen: string;
  params: Record<string, unknown>;
}

const fakeApi: Fetcher = async (req) => {
  await new Promise((r) => setTimeout(r, 150));
  if (req.url.endsWith('/signup')) return { name: (req.body as { name?: string }).name };
  return handleShopRequest({ method: req.method, url: req.url, body: req.body });
};

interface Cart {
  count: number;
  total: number;
  items: Record<string, number>;
}
const emptyCart: Cart = { count: 0, total: 0, items: {} };
const priceOf = (id: string) => products.find((p) => p.id === id)?.price ?? 0;

/** Replace with Segment, Amplitude, Firebase Analytics, Sentry, Datadog… */
const logObserver: Observer = (event) => {
  if (event.type === 'error') console.warn('[zyrox]', event.kind, event.message);
};

export function App() {
  const [stack, setStack] = useState<Entry[]>([{ screen: 'shop-home', params: {} }]);
  // App state that documents read as `app.cart` and change through actions.
  const [cart, setCart] = useState<Cart>(emptyCart);
  const [modal, setModal] = useState<Entry | null>(null);
  // Live preview links from the dashboard QR code: zyroxexample://zyrox-preview?server=…&session=…&token=…
  const [preview, setPreview] = useState<PreviewLink | null>(null);
  useEffect(() => {
    const open = (url: string | null) => {
      const link = url ? parsePreviewLink(url) : null;
      if (link) setPreview(link);
    };
    void Linking.getInitialURL().then(open);
    const sub = Linking.addEventListener('url', ({ url }) => open(url));
    return () => sub.remove();
  }, []);

  const registry = useMemo(
    () =>
      createExampleRegistry({
        addToCart: (id, qty, price) =>
          setCart((c) => ({
            count: c.count + qty,
            total: c.total + qty * (price ?? priceOf(id)),
            items: { ...c.items, [id]: (c.items[id] ?? 0) + qty },
          })),
        removeFromCart: (id, qty) =>
          setCart((c) => {
            const n = Math.min(qty, c.items[id] ?? 0);
            const { [id]: current = 0, ...rest } = c.items;
            return {
              count: c.count - n,
              total: Math.max(0, c.total - n * priceOf(id)),
              items: current - n > 0 ? { ...rest, [id]: current - n } : rest,
            };
          }),
      }),
    [],
  );

  const navigate = (to: string, params: Record<string, unknown>, { presentation }: NavigateOptions) => {
    const entry = { screen: to, params };
    if (presentation === 'modal' || presentation === 'sheet') setModal(entry);
    else if (presentation === 'replace') setStack((s) => [...s.slice(0, -1), entry]);
    else if (presentation === 'reset') setStack([entry]);
    else setStack((s) => [...s, entry]);
  };
  const back = () => {
    if (modal) setModal(null);
    else setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  };

  const top = stack[stack.length - 1]!;
  return (
    <ZyroxProvider
      registry={registry}
      endpoint={endpoint}
      publicKey={publicKey}
      appVersion="1.0.0"
      navigate={navigate}
      back={back}
      documents={documents}
      fetcher={shopApi ? undefined : fakeApi}
      apiBaseUrl={shopApi}
      strings={exampleStrings}
      defaultLocale="en"
      observers={[logObserver]}
      overlays={defaultOverlays}
      app={{ user: { name: 'Ada' }, cart }}
    >
      {/* Your backend drives sheets, toasts and redirects: pushed messages and event-trigger rules. */}
      <ZyroxRemote sources={[uiEvents]} triggers="/ui/triggers" />
      <SafeAreaView style={{ flex: 1 }}>
        <StatusBar style="auto" />
        <Toolbar
          canGoBack={stack.length > 1}
          onBack={back}
          onOpen={(screen) => setStack([{ screen, params: { id: screen === 'product' ? 'p1' : 'fruits' } }])}
        />
        <View style={{ flex: 1 }}>
          {top.screen === 'cart' ? (
            <CartView cart={cart} onClear={() => setCart(emptyCart)} />
          ) : (
            <ScreenView key={`${stack.length}:${top.screen}:${JSON.stringify(top.params)}`} entry={top} />
          )}
        </View>
        <Modal
          visible={Boolean(modal)}
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={back}
        >
          {modal ? <ScreenView entry={modal} /> : null}
        </Modal>
        <Modal visible={Boolean(preview)} animationType="slide" onRequestClose={() => setPreview(null)}>
          <SafeAreaView style={{ flex: 1 }}>
            <Pressable onPress={() => setPreview(null)} style={{ padding: 12 }}>
              <Text style={{ color: '#4f46e5' }}>Close preview</Text>
            </Pressable>
            {preview ? (
              <ZyroxLivePreview
                {...preview}
                loading={<Text style={{ padding: 16 }}>Waiting for the editor…</Text>}
                onClose={() => setPreview(null)}
              />
            ) : null}
          </SafeAreaView>
        </Modal>
      </SafeAreaView>
    </ZyroxProvider>
  );
}

/** Server version when there is one, else the document bundled with the app. */
function ScreenView({ entry }: { entry: Entry }) {
  return (
    <ZyroxScreen
      screen={entry.screen}
      params={entry.params}
      mock={local && mocked.has(entry.screen)}
      loading={<Text style={{ padding: 16 }}>Loading…</Text>}
      fallback={<Text style={{ padding: 16 }}>Screen “{entry.screen}” isn't available.</Text>}
    />
  );
}

/** A screen the app owns natively; documents navigate to it like any other (`"to": "cart"`). */
function CartView({ cart, onClear }: { cart: Cart; onClear(): void }) {
  const actions = useZyroxActions();
  // Reported like Zyrox screens, so trigger rules and analytics see it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per visit
  useEffect(() => actions.screenView('cart', { total: cart.total, count: cart.count }), []);
  const placeOrder = () => {
    onClear();
    actions.track('checkout', { total: cart.total });
    void actions.toast('Order placed', { tone: 'success' });
    // Your order service would push this when a rider picks the order up.
    setTimeout(() => {
      if (shopApi) void fetch(`${shopApi.replace(/\/$/, '')}/ui/demo/order?user=demo`, { method: 'POST' });
      else shopEvents.publish('demo', orderUpdate(String(Date.now())));
    }, 2500);
  };
  const lines = Object.entries(cart.items).map(([id, qty]) => ({
    product: products.find((p) => p.id === id),
    qty,
  }));
  return (
    <View style={{ padding: 16, gap: 8 }}>
      <Text style={{ fontSize: 24, fontWeight: '700' }}>Cart</Text>
      {lines.length ? null : <Text>Your cart is empty.</Text>}
      {lines.map(({ product, qty }) => (
        <View key={product?.id} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text>
            {product?.emoji} {product?.name} × {qty}
          </Text>
          <Text>₹{(product?.price ?? 0) * qty}</Text>
        </View>
      ))}
      <Text style={{ fontWeight: '700' }}>Total ₹{cart.total}</Text>
      <Chip label="Place order (demo)" onPress={placeOrder} disabled={!lines.length} />
    </View>
  );
}

function Toolbar({
  canGoBack,
  onBack,
  onOpen,
}: {
  canGoBack: boolean;
  onBack(): void;
  onOpen(screen: string): void;
}) {
  const i18n = useI18n();
  const next = i18n.locales[(i18n.locales.indexOf(i18n.locale) + 1) % i18n.locales.length] ?? i18n.locale;
  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        padding: 8,
        borderBottomWidth: 1,
        borderColor: '#e2e4e9',
      }}
    >
      <Chip label="← Back" onPress={onBack} disabled={!canGoBack} />
      {Object.keys(documents)
        .filter((key) => !key.startsWith('sections/') && key !== 'shop-product')
        .map((key) => (
          <Chip key={key} label={key} onPress={() => onOpen(key)} />
        ))}
      <Chip label={`Language: ${i18n.locale}`} onPress={() => void i18n.setLocale(next)} />
    </View>
  );
}

function Chip({ label, onPress, disabled }: { label: string; onPress(): void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: '#f4f5f7',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Text>{label}</Text>
    </Pressable>
  );
}
