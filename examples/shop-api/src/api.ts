import { categories, collections, products } from './catalog';
import type { Feed, Product, ProductPage, Section } from './contract';
import { applyCoupon, uiTriggers } from './ui';

export interface ShopRequest {
  method: string;
  /** Path with query, e.g. `/collections/fruits?page=2`. Absolute URLs work too. */
  url: string;
  body?: unknown;
}

export class ShopError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** JSON error body, e.g. `{ errors: { email: 'Already registered' } }` for field errors. */
    readonly body?: unknown,
  ) {
    super(message);
  }
}

const TAKEN_USERNAMES = new Set(['ada', 'admin', 'zyrox', 'support']);

/** Username availability, for live validation while typing. */
export function usernameAvailable(username: string): { username: string; available: boolean } {
  const u = username.trim().toLowerCase();
  return { username: username.trim(), available: !TAKEN_USERNAMES.has(u) };
}

export interface Registration {
  name?: string;
  email?: string;
  username?: string;
  password?: string;
  business?: boolean;
  company?: string;
  gstin?: string;
  pincode?: string;
}

/**
 * Creates an account. The server re-checks everything the form checks (never trust the client)
 * and answers 422 with `{ errors: { field: message } }` for problems only it can see.
 */
export function register(input: Registration): { id: string; name: string; username: string } {
  const errors: Record<string, string> = {};
  if (!input.name?.trim()) errors.name = 'Enter your name';
  if (!input.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) errors.email = 'Enter a valid email';
  else if (input.email.toLowerCase().startsWith('taken')) errors.email = 'This email is already registered';
  if (!input.username || input.username.trim().length < 3) errors.username = 'At least 3 characters';
  else if (!usernameAvailable(input.username).available) errors.username = 'That username is taken';
  if (!input.password || input.password.length < 8) errors.password = 'At least 8 characters';
  if (input.business && !input.company?.trim()) errors.company = 'Enter your company name';
  if (Object.keys(errors).length) throw new ShopError(422, 'Check the highlighted fields', { errors });
  const username = input.username!.trim();
  return { id: `u_${username.toLowerCase()}`, name: input.name!.trim(), username };
}

const PAGE_SIZE = 6;

function page(id: string, pageNumber: number): ProductPage {
  const collection = collections[id];
  if (!collection) throw new ShopError(404, `No collection "${id}"`);
  const all = products.filter(collection.match);
  const start = (pageNumber - 1) * PAGE_SIZE;
  return {
    id,
    title: collection.title,
    products: all.slice(start, start + PAGE_SIZE),
    page: pageNumber,
    next: start + PAGE_SIZE < all.length ? pageNumber + 1 : null,
  };
}

/**
 * The home feed. The backend owns the order and content of sections (personalization,
 * campaigns, experiments, inventory); the app's Zyrox documents own how each section type looks.
 */
export function homeFeed(options: { segment?: string; hour?: number } = {}): Feed {
  const hour = options.hour ?? new Date().getHours();
  const newUser = options.segment === 'new';
  const sections: Section[] = [
    {
      id: 'hero',
      type: 'banners',
      items: [
        {
          id: 'festive',
          title: 'Festive store is live',
          subtitle: 'Diyas, sweets and more in 10 minutes',
          emoji: '🪔',
          color: '#ffedd5',
          link: { screen: 'shop-collection', params: { id: 'festive' } },
        },
        {
          id: 'fresh',
          title: 'Farm-fresh fruits',
          subtitle: 'Up to 25% off',
          emoji: '🍎',
          color: '#fee2e2',
          link: { screen: 'shop-collection', params: { id: 'fruits' } },
        },
        {
          id: 'snacks',
          title: 'Snacks under ₹99',
          emoji: '🍿',
          color: '#fef9c3',
          link: { screen: 'shop-collection', params: { id: 'under99' } },
        },
      ],
    },
    {
      id: 'categories',
      type: 'categories',
      title: 'Shop by category',
      items: categories.map((c) => ({ ...c, link: { screen: 'shop-collection', params: { id: c.id } } })),
    },
  ];
  // A section designed in the Zyrox dashboard, placed by the backend with its own parameters.
  sections.push(
    newUser
      ? {
          id: 'welcome',
          type: 'zyrox',
          screen: 'sections/festive-sale',
          params: { title: 'Flat ₹100 off your first order', code: 'FIRST100', collection: 'bestsellers' },
        }
      : {
          id: 'sale',
          type: 'zyrox',
          screen: 'sections/festive-sale',
          params: { title: 'Festive sale: up to 30% off', code: 'DIWALI30', collection: 'festive' },
        },
  );
  sections.push({
    id: 'bestsellers',
    type: 'rail',
    title: 'Bestsellers',
    api: { url: '/collections/bestsellers' },
    seeAll: { screen: 'shop-collection', params: { id: 'bestsellers' } },
  });
  // Time-based ranking: breakfast in the morning, snacks later.
  const timely = hour < 11 ? 'daily' : 'under99';
  sections.push({
    id: timely,
    type: 'rail',
    title: hour < 11 ? 'Breakfast essentials' : 'Snacks under ₹99',
    api: { url: `/collections/${timely}` },
    seeAll: { screen: 'shop-collection', params: { id: timely } },
  });
  // A widget only newer app builds know: older builds skip it, nothing breaks.
  sections.push({ id: 'stories', type: 'stories', items: [] } as unknown as Section);
  return { header: { eta: '10 minutes', address: 'Home · Indiranagar, Bengaluru' }, sections };
}

export function search(query: string): { query: string; products: Product[] } {
  const q = query.trim().toLowerCase();
  return {
    query,
    products: q
      ? products.filter((x) => `${x.name} ${x.category}`.toLowerCase().includes(q)).slice(0, 12)
      : [],
  };
}

/** Routes a request to the example backend. Returns JSON, or throws `ShopError`. */
export async function handleShopRequest(request: ShopRequest): Promise<unknown> {
  // Plain string parsing: runs anywhere, including React Native (whose URL lacks searchParams).
  const [rawPath = '', rawQuery = ''] = request.url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '').split('?');
  const pathname = `/${rawPath.replace(/^\/+|\/+$/g, '')}`;
  const parts = pathname.slice(1).split('/');
  const params = new Map(
    rawQuery
      .split('&')
      .filter(Boolean)
      .map((pair) => {
        const [k = '', v = ''] = pair.split('=');
        return [decodeURIComponent(k), decodeURIComponent(v.replace(/\+/g, ' '))] as const;
      }),
  );
  const query = { get: (k: string) => params.get(k) ?? null, has: (k: string) => params.has(k) };
  if (request.method === 'GET') {
    if (pathname === '/feed/home')
      return homeFeed({
        segment: query.get('segment') ?? undefined,
        hour: query.has('hour') ? Number(query.get('hour')) : undefined,
      });
    if (parts[0] === 'collections' && parts[1])
      return page(parts[1], Math.max(1, Number(query.get('page') ?? 1)));
    if (parts[0] === 'search') return search(query.get('q') ?? '');
    if (pathname === '/username-available') return usernameAvailable(query.get('u') ?? '');
    if (parts[0] === 'products' && parts[1]) {
      const product = products.find((x) => x.id === parts[1]);
      if (!product) throw new ShopError(404, 'Product not found');
      return product;
    }
  }
  if (request.method === 'POST' && pathname === '/register')
    return register((request.body ?? {}) as Registration);
  if (request.method === 'POST' && pathname === '/coupons/apply')
    return applyCoupon(String((request.body as { code?: unknown } | undefined)?.code ?? ''));
  if (request.method === 'GET' && pathname === '/ui/triggers') return { triggers: uiTriggers() };
  throw new ShopError(404, `No route for ${request.method} ${pathname}`);
}
