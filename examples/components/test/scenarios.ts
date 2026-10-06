import type { Document } from '@zyrox/protocol';
import { handleShopRequest, uiTriggers } from '@zyrox-examples/shop-api';
import { counter, home, product, register, shopHome, signup } from '../documents';

/** One user-level step, run the same way on web and native. */
export type Step =
  | { text: string }
  | { noText: string }
  | { press: string }
  | { type: string; value: string }
  | { blur: string }
  | { toggle: string }
  | { wait: number }
  | { called: 'navigate' | 'addToCart' | 'fetcher'; with: unknown[] };

export interface Scenario {
  name: string;
  document: Document;
  params?: Record<string, unknown>;
  mock?: boolean;
  /** The backend the fetcher talks to (default: answers every request with `{ name: 'Ada' }`). */
  api?: (request: { method: string; url: string; body?: unknown }) => Promise<unknown>;
  /** Event-trigger rules from the backend (renders `<ZyroxRemote>`). */
  triggers?: unknown[];
  steps: Step[];
}

/** The same documents, interactions and expectations for every platform. */
export const scenarios: Scenario[] = [
  {
    name: 'counter',
    document: counter,
    steps: [
      { text: 'Count: 0' },
      { noText: "That's a lot" },
      { press: 'Increase' },
      { press: 'Increase' },
      { press: 'Increase' },
      { text: 'Count: 3' },
      { text: "That's a lot" },
      { press: 'Decrease' },
      { text: 'Count: 2' },
    ],
  },
  {
    name: 'signup',
    document: signup,
    steps: [
      { type: 'Name', value: 'Ada' },
      { type: 'Email', value: 'ada' },
      { noText: 'Enter a valid email' },
      { blur: 'Email' },
      { text: 'Enter a valid email' },
      { type: 'Email', value: 'ada@example.com' },
      { noText: 'Enter a valid email' },
      { toggle: 'I accept the terms' },
      { press: 'Create account' },
      {
        called: 'fetcher',
        with: [
          { url: '/signup', method: 'POST', body: { name: 'Ada', email: 'ada@example.com', terms: true } },
        ],
      },
      { called: 'navigate', with: ['welcome', { name: 'Ada' }, { presentation: 'push' }] },
    ],
  },
  {
    // Declarative validation: rules, cross-field checks, conditional fields, a live API check
    // and field errors returned by the server.
    name: 'register',
    document: register,
    api: (req) => handleShopRequest(req),
    steps: [
      { press: 'Create account' },
      { text: 'Enter your name' },
      { text: 'Choose a username' },
      { text: 'Fix the highlighted fields to continue.' },
      { type: 'Full name', value: 'Ada Lovelace' },
      { noText: 'Enter your name' },
      { type: 'Email', value: 'taken@example.com' },
      { type: 'Username', value: 'Ada' },
      { text: 'Use lowercase letters, numbers and _' },
      { type: 'Username', value: 'ada' },
      { wait: 450 },
      { text: '“ada” is taken' },
      { type: 'Username', value: 'ada_l' },
      { text: 'Checking…' },
      { wait: 450 },
      { text: '✓ Available' },
      { type: 'Password', value: 'secret' },
      { text: 'Enter at least 8 characters' },
      { type: 'Password', value: 'secret123' },
      { type: 'Repeat password', value: 'secret12' },
      { text: "Passwords don't match" },
      { type: 'Repeat password', value: 'secret123' },
      { noText: "Passwords don't match" },
      { toggle: 'Business account' },
      { text: 'Enter your company name' },
      { type: 'Company name', value: 'Analytical Engines' },
      { type: 'GSTIN', value: '29ABCDE1234F1Z5' },
      { type: 'PIN code', value: '560038' },
      { noText: 'Fix the highlighted fields to continue.' },
      { press: 'Create account' },
      {
        called: 'fetcher',
        with: [{ url: '/register', method: 'POST' }],
      },
      { text: 'This email is already registered' },
      { type: 'Email', value: 'ada@example.com' },
      { noText: 'This email is already registered' },
      { press: 'Create account' },
      { text: 'Welcome, @ada_l!' },
    ],
  },
  {
    name: 'product',
    document: product,
    params: { id: 'p1' },
    mock: true,
    steps: [
      { text: '$129.50' },
      { text: 'New' },
      { text: 'Sock' },
      { press: 'Increase quantity' },
      { text: '$259.00' },
      { press: 'Add 2 to cart' },
      { called: 'addToCart', with: ['p1', 2] },
      { press: 'Cap' },
      { called: 'navigate', with: ['product', { id: 'p3' }, { presentation: 'push' }] },
    ],
  },
  {
    // Backend-driven feed: banners, categories, a dashboard-designed section and a product rail
    // (the rail is its own document with its own data source).
    name: 'shop feed',
    document: shopHome,
    mock: true,
    steps: [
      { text: 'Delivery in 10 minutes' },
      { text: 'Festive store is live' },
      { text: 'Shop by category' },
      { text: 'Dairy & Eggs' },
      { text: 'Festive sale: up to 30% off' },
      { text: 'Use code DIWALI30 at checkout' },
      { text: 'Bestsellers' },
      { text: 'Robusta Banana' },
      { text: '18% OFF' },
      { press: 'Add Robusta Banana' },
      { called: 'addToCart', with: ['banana', 1, 49] },
      { press: 'Copy code' },
      { text: 'Copied ✓' },
      { press: 'Festive store is live' },
      { called: 'navigate', with: ['shop-collection', { id: 'festive' }, { presentation: 'push' }] },
      { press: 'See all Bestsellers' },
      { called: 'navigate', with: ['shop-collection', { id: 'bestsellers' }, { presentation: 'push' }] },
    ],
  },
  {
    // UI the backend triggers: a rule on `add_to_cart` opens a sheet, the app-open rule shows a
    // toast, and the coupon API answers with `$actions`.
    name: 'backend-driven UI',
    document: shopHome,
    mock: true,
    api: (req) => handleShopRequest(req),
    triggers: uiTriggers(),
    steps: [
      { text: 'Delivering to Home · Indiranagar in 10 minutes' },
      { press: 'Add Robusta Banana' },
      { text: 'Free delivery over ₹199' },
      { text: 'Add ₹150 more to skip the delivery fee.' },
      { press: 'Keep shopping' },
      { noText: 'Free delivery over ₹199' },
      { press: 'Apply DIWALI30' },
      { text: 'DIWALI30 applied: 30% off festive items' },
    ],
  },
  {
    name: 'home',
    document: home,
    mock: true,
    steps: [
      { text: 'Home' },
      { text: 'Good morning, Ada' },
      { text: 'Free shipping' },
      { text: 'Trail Shoe' },
    ],
  },
];
