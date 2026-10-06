# Using Zyrox in your app

This guide covers `@zyrox/react` in a React (web) or React Native / Expo app: from registering your components to production caching and tests. The same code runs on both platforms; only your component implementations differ.

- [1. Concepts](#1-concepts)
- [2. Install](#2-install)
- [3. Define your components](#3-define-your-components)
- [4. Implement them per platform](#4-implement-them-per-platform)
- [5. App actions](#5-app-actions)
- [6. The registry and the manifest](#6-the-registry-and-the-manifest)
- [7. The provider](#7-the-provider)
- [8. Screens](#8-screens)
- [9. Documents: layout, expressions and state](#9-documents-layout-expressions-and-state)
- [10. Data: static, dynamic and reactive API calls](#10-data-static-dynamic-and-reactive-api-calls)
- [11. Actions in documents](#11-actions-in-documents) (and [forms and validation](#forms-and-validation))
- [12. Navigation](#12-navigation)
- [13. Remote functions](#13-remote-functions)
- [14. Languages](#14-languages)
- [15. Motion and transitions](#15-motion-and-transitions)
- [16. Analytics, logging and error tracking](#16-analytics-logging-and-error-tracking)
- [17. Caching, offline and performance](#17-caching-offline-and-performance)
- [18. Previews: dashboard canvas and devices](#18-previews-dashboard-canvas-and-devices)
- [19. Compatibility with older app builds](#19-compatibility-with-older-app-builds)
- [20. Security](#20-security)
- [21. Testing](#21-testing)
- [22. CLI and CI](#22-cli-and-ci)
- [23. Reference](#23-reference)

## 1. Concepts

| Term | Meaning |
| --- | --- |
| **Component definition** | A name plus a Zod schema of props, events, slots and templates (`defineComponent`). No React code. |
| **Implementation** | Your React or React Native component for a definition (`implement`). |
| **Registry** | All implementations, app actions, helpers, observers and the motion adapter of one app build. |
| **Manifest** | The JSON description of what one app build supports (from the registry), identified by a hash. Uploaded to the server so the dashboard, validation and AI know your components. |
| **Document** | A screen or block as JSON: a tree of nodes (`type` = one of your components), plus state, params and data sources. |
| **Version** | An immutable, published document, addressed by its content hash. |
| **Release** | Which version each environment (dev / staging / prod) serves, with optional rules, rollouts and experiments. |
| **Bootstrap** | The small per-user response that maps document keys to version hashes. |

The server never sends code. Documents only reference components and actions your app registered, and expressions run in a sandboxed evaluator.

## 2. Install

```bash
npm i @zyrox/react zod
npm i -D @zyrox/cli
```

Zyrox isn't published to npm yet. Until it is, either develop inside this monorepo (add your app next to `examples/`), or publish the packages to a private registry with `pnpm -r publish` (workspace versions are rewritten on publish). The packages ship TypeScript sources, which Metro, Expo, Vite and tsx compile out of the box. For Next.js add them to `transpilePackages`.

Requirements: React 18.2+ (19 recommended). React Native 0.76+ (New Architecture), Expo SDK 52+.

## 3. Define your components

A definition is the contract between your code and the server. Keep definitions in files without React imports: the CLI loads them in Node to build the manifest.

```ts
// src/zyrox/defs.ts
import { defineComponent, defineAction, extendComponent, z, zx } from '@zyrox/react';

export const ProductCardDef = defineComponent({
  name: 'ProductCard',                                  // what documents use as "type"
  description: 'Product tile: image, name, price, ADD button.', // shown to editors and AI
  source: 'src/components/ProductCard.tsx',             // where the code lives (agents use it)
  props: z.object({
    name: z.string(),
    image: zx.image().optional(),                       // editor widgets: zx.image(), zx.color(), zx.url(), zx.multiline()
    price: z.number(),
    mrp: z.number().optional(),
    tone: z.enum(['default', 'promo']).default('default'), // design tokens as enums
    qty: z.number().int().min(0).default(0),
  }),
  events: ['press', 'add', 'remove'],                   // or { add: z.object({ qty: z.number() }) } for typed payloads
  children: false,                                      // true: a default children slot
  slots: ['badge'],                                     // named slots → props.slots.badge
  templates: [],                                        // item renderers → props.templates.item(item, index)
});
```

| Field | Notes |
| --- | --- |
| `props` | A `z.object`. Defaults apply when a document omits a prop or an expression yields `null`. Use enums for design tokens (tone, size, spacing) instead of raw colors. |
| `events` | Names (`['press']`) or names mapped to payload schemas. Your component receives `onPress`, `onAdd`… only when the document wires that event. |
| `children` | Accepts a default list of child nodes. |
| `slots` | Named lists of nodes (header, footer, empty state…). |
| `templates` | A node rendered once per item, e.g. for `FlatList`'s `renderItem`. |
| `bind` | Two-way binding for inputs: `{ prop: 'value', event: 'change' }` lets documents write `"bind": "form.email"`. |

**Inputs:**

```ts
export const TextFieldDef = defineComponent({
  name: 'TextField',
  props: z.object({ label: z.string().optional(), value: z.string().default(''), error: z.string().optional() }),
  events: { change: z.string(), submit: z.object({}) },
  bind: { prop: 'value', event: 'change' },
});
```

**Extending a definition** (a new component that reuses another's contract):

```ts
export const PromoCardDef = extendComponent(ProductCardDef, {
  name: 'PromoCard',
  props: { countdown: z.string() },          // or (base) => base.omit({ tone: true })
  events: ['dismiss'],
  slots: ['footer'],
});
```

Scaffold a definition plus web and native starter code with `npx zyrox scaffold component ProductCard --prop name:string! --prop price:number --prop tone:default|promo=default --event press`.

## 4. Implement them per platform

```tsx
// src/components/ProductCard.tsx (web)
import { implement } from '@zyrox/react';
import { ProductCardDef } from '../zyrox/defs';

export const ProductCard = implement(ProductCardDef, ({ name, image, price, qty, onPress, onAdd, onRemove, slots, nodeId, a11y }) => (
  <MyCard onClick={onPress} data-testid={nodeId} aria-label={a11y?.label}>
    {image ? <img src={image} alt="" /> : null}
    <h3>{name}</h3>
    <Price value={price} />
    {qty > 0 ? <Stepper value={qty} onPlus={onAdd} onMinus={onRemove} /> : <button onClick={() => onAdd?.()}>ADD</button>}
    {slots.badge}
  </MyCard>
));
```

```tsx
// src/components/ProductCard.native.tsx (React Native; Metro picks .native.tsx automatically)
export const ProductCard = implement(ProductCardDef, ({ name, price, onPress, nodeId }) => (
  <Pressable testID={nodeId} onPress={onPress} accessibilityRole="button" accessibilityLabel={name}>
    <Text>{name}</Text>
    <Text>{price}</Text>
  </Pressable>
));
```

Your component receives:

| Prop | Meaning |
| --- | --- |
| schema props | Parsed, defaults applied, typed from the schema (`ZyroxComponentProps<typeof ProductCardDef>`) |
| `on<Event>` | Handlers for events the document wired; `undefined` otherwise (so `onPress === undefined` means "not pressable") |
| `children` | Rendered default slot |
| `slots.<name>` | Rendered named slots (`null` when empty) |
| `templates.<name>(item, index)` | Item renderers: use as `renderItem` for `FlatList` / FlashList |
| `a11y` | `{ label, hint, role }` from the document |
| `nodeId` | The node id, handy for test ids |
| `meta` | The node's free-form `meta` |

Use your design system inside. If it's already cross-platform (Tamagui, NativeWind, Unistyles, react-native-web), one file is enough.

A component may render another Zyrox document. That's how feed sections that load their own data work (see the [dynamic feed](dynamic-feed.md)):

```tsx
export const Section = implement(SectionDef, ({ screen, params }) => <ZyroxScreen screen={screen} params={params} fallback={null} />);
```

## 5. App actions

Things only your app can do (cart, auth, native modules, payments) are actions with a schema:

```ts
// defs.ts
export const AddToCartDef = defineAction({
  name: 'addToCart',
  description: 'Adds a product to the cart.',
  args: z.object({ productId: z.string(), qty: z.number().int().min(1).default(1) }),
});

// actions.ts
import { implementAction } from '@zyrox/react';
export const addToCart = implementAction(AddToCartDef, async ({ productId, qty }, ctx) => {
  await cart.add(productId, qty);
  ctx.track('add_to_cart', { productId });     // ctx: screen, nodeId, event, getState, setState, navigate, track, refresh
});
```

Documents call it like a built-in action: `{ "do": "addToCart", "productId": "{{ item.id }}", "qty": 1 }`. Arguments are validated against the schema at publish time and at runtime.

## 6. The registry and the manifest

```ts
import { createRegistry, definePlugin } from '@zyrox/react';

export const registry = createRegistry({
  components: [ProductCard, TextField /* … */],
  actions: [addToCart],
  helpers: { price: (n: number) => `₹${n}` },   // extra expression helpers: {{ price(item.price) }}
  observers: [analyticsObserver],
  motion: reanimatedMotion,                        // see Motion
  transitions: ['slide', 'fade'],                  // names your navigator understands
  tokens: { color: { primary: '#4f46e5' }, space: { md: 16 } }, // informational, for the dashboard and AI
  plugins: [definePlugin({ name: 'maps', components: [MapView] })], // reusable bundles
});
```

`registry.manifest` describes this build; its `hash` is sent with every request so the server knows what the app supports. Upload it from CI for every build (the dashboard, publish-time validation and agents use it):

```ts
// zyrox.config.ts (Node: definitions only)
import { defineConfig } from '@zyrox/cli';
import { ProductCardDef, TextFieldDef, AddToCartDef } from './src/zyrox/defs';

export default defineConfig({
  server: 'https://ui.example.com',
  project: 'shop',
  manifest: { components: [ProductCardDef, TextFieldDef], actions: [AddToCartDef], helpers: ['price'], motions: ['fade', 'slideUp'], transitions: ['slide', 'fade'], tokens },
  documents: './zyrox',
});
```

```bash
npx zyrox manifest push --label "$APP_VERSION"
```

Share one `manifestInput` object between `createRegistry` and the config so both produce the same hash (the example apps do this and test it).

## 7. The provider

```tsx
import { ZyroxProvider } from '@zyrox/react';

<ZyroxProvider
  registry={registry}
  // Delivery
  endpoint="https://ui.example.com"           // omit to render bundled / inline documents only
  publicKey={IS_PROD ? 'pk_prod_…' : 'pk_dev_…'}
  appVersion="3.4.1"                          // usable in release rules: semver(client.app, '>=3.4')
  user={userIdOrInstallId}                     // sticky rollouts and experiments (generated if omitted)
  attrs={{ country: 'IN', plan: 'pro' }}       // targeting attributes
  userToken={() => auth.idToken}               // forwarded to remote functions so they can verify the caller
  storage={mmkvStorage}                        // see Caching
  snapshot={require('./zyrox.snapshot.json')}  // first launch, offline
  documents={bundledDocuments}                 // screens shipped in the app (fallback / local dev)
  // Your app
  fetcher={authedFetch}                        // data sources and the request action, with YOUR auth
  apiBaseUrl="https://api.example.com"
  navigate={(to, params, { presentation, transition }) => …}
  back={(result) => …}
  observers={[segment, sentry]}
  app={{ user, cart, flags }}                  // read in documents as {{ app.cart.count }}
  // Languages
  strings={{ en, hi }} defaultLocale="en"
>
  <App />
</ZyroxProvider>
```

Every prop is listed in the [reference](#23-reference). Props are read live: changing `app` re-renders only the nodes that read the changed values.

## 8. Screens

```tsx
<ZyroxScreen screen="home" params={{ tab: 'deals' }} loading={<Skeleton />} fallback={<NativeHome />} />
```

- `screen` loads the released version for this user. If the server has none (or there is no server), a document of that key from the provider's `documents` renders.
- `document={doc}` renders an inline document (tests, bundled screens, server rendering: `fetchScreen` from `@zyrox/core` gets one screen for a user in one request, see the [headless guide](headless.md#server-side-rendering)).
- `fallback` renders when the document can't be loaded or uses a newer protocol. Ship a native version of critical screens.
- A mounted screen keeps the version it opened with, so nothing changes under the user's finger. Pass `live` to switch immediately (dashboards, kiosks).
- Screens can be embedded anywhere: a section of a native screen, a tab, a modal, a bottom sheet, a cell.
- `onEvent` adds an observer for this screen only.

Reading and writing a screen's state from your own components:

```tsx
const [qty, setQty] = useScreenState<number>('qty');   // inside a component rendered by a Zyrox screen
const runtime = useScreenRuntime();                     // run actions, read data: runtime.refresh('feed')
```

## 9. Documents: layout, expressions and state

```jsonc
{
  "zyrox": 1, "kind": "screen", "key": "product", "title": "Product",
  "params": { "id": { "type": "string", "required": true } },
  "state": { "qty": 1 },
  "data": { "product": { "url": "/products/{{ params.id }}", "mock": { "name": "Trail Shoe", "price": 129.5 } } },
  "root": {
    "id": "root", "type": "Screen",
    "children": [
      { "id": "name", "type": "Text", "props": { "text": "{{ data.product.name }}", "variant": "title" } },
      { "id": "qty", "type": "Stepper", "bind": "qty" },
      { "id": "add", "type": "Button",
        "props": { "label": "Add {{ state.qty }} · {{ format.currency(data.product.price * state.qty, 'USD') }}" },
        "on": { "press": [{ "do": "addToCart", "productId": "{{ params.id }}", "qty": "{{ state.qty }}" }] } }
    ]
  }
}
```

**Node fields:** `id` (unique, readable), `type`, `props`, `children`, `slots`, `templates`, `on` (event → actions), `bind` (state path), `if`, `repeat` (`{ "each": "{{ list }}", "as": "row", "key": "{{ row.id }}" }`), `with` (local variables), `fallback` (node used when the app build lacks `type`), `a11y`, `motion`, `meta`.

**Expressions** go in `{{ }}`. A string that is exactly one expression keeps its type (`"{{ state.qty }}"` is a number); otherwise values are interpolated. The language is a safe JavaScript subset: property access, arithmetic, comparisons (`==` is strict), `&& || ?? !`, ternaries, array and object literals, helper calls. No assignments, loops, functions or globals.

| Scope | Contents |
| --- | --- |
| `state` | The screen's state (initial values from `state`) |
| `data`, `loading`, `error` | Data source results and their status, by key |
| `params` | Navigation params |
| `app` | The provider's `app` prop |
| `device` | `platform`, `width`, `height`, `colorScheme`, `locale`, `direction` |
| `i18n` | `locale`, `direction`, `locales` |
| `item`, `index` | Inside templates and `repeat` |
| `event` | Inside actions: the event payload or response |

**Helpers:** `len includes upper lower trim join slice keys coalesce min max round floor ceil abs number string json semver concat merge pluck find filterBy sortBy sum unique t format.number format.currency format.percent format.date`, plus your own.

Responsive layouts need no special feature: `"direction": "{{ device.width > 768 ? 'row' : 'column' }}"`.

**Blocks** are reusable fragments (`"kind": "block"`) that take `input`: `{ "id": "promo", "type": "@block/promo-banner", "props": { "title": "Sale" } }`. They're inlined when a screen is published, so clients never resolve them.

## 10. Data: static, dynamic and reactive API calls

Zyrox never talks to your API directly. Every data request goes through **your** `fetcher`, with your auth, retries and tracing:

```ts
const fetcher: Fetcher = async ({ url, method, headers, body, signal, kind, key, source }) => {
  const res = await fetch(url, {
    method, signal,
    headers: { ...headers, authorization: `Bearer ${await auth.token()}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new FetchError(json?.message ?? `HTTP ${res.status}`, res.status, json); // → error.<key>, event in onError
  return json;
};
```

`kind` lets one fetcher serve REST, GraphQL (`"kind": "graphql"` with the query in `body`) or anything else. Relative URLs are resolved against `apiBaseUrl`. Absolute URLs must be on `apiBaseUrl`'s origin or in `allowedOrigins`.

Data sources:

```jsonc
"data": {
  "feed":    { "url": "/feed/home", "refresh": ["mount", "foreground"], "cache": 30 },            // static
  "rail":    { "url": "{{ params.api }}", "cache": 60 },                                         // dynamic: URL from params / another response
  "orders":  { "url": "/users/{{ data.me.id }}/orders", "if": "{{ data.me.id }}" },              // chained
  "results": { "url": "/search?q={{ state.q }}", "if": "{{ len(state.q) > 1 }}", "debounce": 300 }, // reactive
  "scores":  { "url": "/scores", "refresh": ["mount", 15] },                                     // polling
  "cart":    { "url": "/graphql", "method": "POST", "kind": "graphql", "body": { "query": "{ cart { count } }" } }
}
```

| Field | Meaning |
| --- | --- |
| `url`, `method`, `headers`, `body` | The request; any value can be an expression |
| `refresh` | `mount` (default), `foreground`, and/or seconds (polling) |
| `if` | Fetch only while truthy (wait for another source, a filled field) |
| `debounce` | Milliseconds to wait after inputs change (search-as-you-type) |
| `cache` | Seconds to reuse a response for the same request across screens; older responses still show at once while a fresh one loads |
| `mock` | Sample response for the dashboard canvas, device previews and tests |

A source refetches automatically when anything its request reads changes (`state.q`, `params.id`, `data.me.id`). Results are at `data.<key>`, status at `loading.<key>` and `error.<key>` (`{ message, status, body }`). Refresh manually with `{ "do": "refresh", "data": "feed" }`.

Sending data is an action (next section). Pagination appends with helpers:

```jsonc
{ "do": "request", "url": "/items?page={{ state.next ?? data.first.next }}",
  "onSuccess": [{ "do": "setState", "path": "more", "value": "{{ concat(state.more, event.items) }}" },
                { "do": "setState", "path": "next", "value": "{{ event.next ?? 0 }}" }] }
```

The [dynamic feed example](dynamic-feed.md) puts these together: a backend-ordered feed where some sections are inline data and others fetch their own API.

## 11. Actions in documents

Actions run in order; a failed action stops the list and reports an error event.

| Action | Arguments |
| --- | --- |
| `setState` | `path` (relative to `state`, e.g. `form.email`), `value` |
| `navigate` | `to`, `params`, `presentation` (`push` `replace` `modal` `sheet` `reset`), `transition` |
| `back` | `result` |
| `openUrl` | `url` (schemes in `urlSchemes`; default https, http, mailto, tel) |
| `request` | `url`, `method`, `headers`, `body`, `into` (state path), `onSuccess`, `onError` (`event` = response / error) |
| `call` | `fn`, `args`, `into`, `onSuccess`, `onError`: a [remote function](#13-remote-functions) |
| `refresh` | `data` (one source, or all) |
| `track` | `event`, `props`: goes to your observers |
| `setLocale` | `locale` |
| `validate` | `form`: shows every error; stops the list while the form is invalid ([forms](#forms-and-validation)) |
| `resetForm` | `form`, `values` (default: the initial state) |
| `setErrors` | `form`, `errors` (`{ field: message }` or `[{ field, message }]`, e.g. from your API) |
| `sheet` | `screen` (document key), `document` (inline) or `content` (`title`, `message`, `image`, `buttons`); `params`, `title`, `size`, `dismissible`, `id`, `onClose` ([overlays](#sheets-alerts-and-toasts)) |
| `closeSheet` | `id` (default: the top one), `result` (the sheet's `onClose` gets it as `event`) |
| `alert` | `title`, `message`, `buttons` (`[{ label, style, actions }]`); waits for a button |
| `toast` | `message`, `tone`, `duration`, `action` (`{ label, actions }`) |
| `if` | `cond`, `then`, `else` |
| your actions | their arguments |

```jsonc
"on": { "press": [
  { "do": "setState", "path": "submitting", "value": true },
  { "do": "request", "url": "/signup", "method": "POST", "body": "{{ state.form }}", "into": "result",
    "onSuccess": [{ "do": "navigate", "to": "welcome", "params": { "name": "{{ event.name }}" }, "presentation": "replace" }],
    "onError": [{ "do": "setState", "path": "error", "value": "{{ event.message }}" }] },
  { "do": "setState", "path": "submitting", "value": false }
] }
```

### Forms and validation

Declare a form's rules next to its state; Zyrox checks them as the user types, shows errors on your components, and blocks submission while anything is invalid. Rules are data, so a screen's validation changes with the screen, without an app release.

```jsonc
"state": { "account": { "email": "", "password": "", "confirm": "", "business": false, "company": "" } },
"forms": {
  "account": {                              // validates state.account
    "show": "touched",                      // or "submit": errors appear only after `validate`
    "fields": {
      "email":    { "required": "Enter your email", "email": true },
      "password": { "required": true, "minLength": 8,
                    "pattern": { "value": "[0-9]", "message": "Add at least one number" } },
      "confirm":  { "equals": { "value": "{{ state.account.password }}", "message": "Passwords don't match" } },
      "company":  { "if": "{{ state.account.business }}", "required": "Enter your company name" },
      "username": { "rules": [{ "check": "{{ data.availability.available }}", "message": "“{{ value }}” is taken" }] }
    }
  }
}
```

| Rule | Value |
| --- | --- |
| `required` | `true` or a message. Empty means `undefined`, `null`, `false`, blank text or an empty list. |
| `minLength`, `maxLength` | Text or list length |
| `min`, `max` | Numbers (numeric text is accepted) |
| `pattern` | A regular expression the value must match, e.g. `^[1-9][0-9]{5}$` |
| `email`, `url` | `true` or a message |
| `oneOf` | Allowed values |
| `equals` | Another value, e.g. `"{{ state.account.password }}"` |
| `rules` | Custom checks `[{ "check": "{{ … }}", "message": "…" }]`: invalid while `check` is falsy. Use them for anything else: cross-field conditions, results of an API check (`data.*`), dates. |
| `if` | Validate this field only while truthy (conditional fields) |

Every rule value can be an expression, and `{ "value": …, "message": "…" }` gives it its own message. Inside rules, `value` is the field's value. Field keys are paths under the form's state (`address.pincode`). Rules re-run when anything they read changes, so `confirm` re-checks when `password` changes and `company` stops counting when `business` is off. Messages can be expressions or `t()` keys; default messages translate with `zyrox.form.<rule>` keys (`zyrox.form.required`, `zyrox.form.minLength` with `{n}`, …).

**Showing errors.** A component bound to a form field (`"bind": "account.email"`) receives `error` (when its schema has an `error` prop and the node doesn't set one) and `required` (for required fields without `if`). Errors appear once the field is touched: when it loses focus if the component has a `blur` event, otherwise on the first change; and for every field after `validate`. Elsewhere, read `forms.<name>`:

| | |
| --- | --- |
| `forms.account.valid` | No errors (shown or not) |
| `forms.account.errors.email` | The current error, or `null` |
| `forms.account.shown.email` | The error to display now (after touch or submit) |
| `forms.account.touched.email`, `forms.account.submitted` | Interaction state |
| `forms.account.required.email` | For your own asterisks |

```jsonc
{ "id": "terms-error", "type": "Text", "if": "{{ forms.account.shown.terms }}",
  "props": { "text": "{{ forms.account.shown.terms }}", "tone": "danger" } }
```

**Submitting.** Start the action list with `validate`; the rest runs only when the form is valid. Your API stays the source of truth: return field errors (e.g. HTTP 422 `{ "errors": { "email": "Already registered" } }`) and pass them to `setErrors`. They show until the user edits that field.

```jsonc
"press": [
  { "do": "validate", "form": "account" },
  { "do": "request", "url": "/register", "method": "POST", "body": "{{ state.account }}",
    "onSuccess": [{ "do": "resetForm", "form": "account" }, { "do": "navigate", "to": "welcome" }],
    "onError": [{ "do": "setErrors", "form": "account", "errors": "{{ event.body.errors ?? {} }}" }] }
]
```

`event.body` is the JSON error body: throw a `FetchError(message, status, body)` from your fetcher (or any error with `status` and `body` properties). Live checks while typing are ordinary data sources: the `register` example checks username availability with a debounced request and a custom rule. `zyrox validate` reports unknown forms, invalid patterns and rule expressions before you publish.

### Sheets, alerts and toasts

`sheet`, `alert` and `toast` render through the provider's `overlays`: the defaults from `@zyrox/react/overlays` (web: accessible dialogs; React Native: a `Modal` sheet, the native `Alert.alert`, toasts) or your design system's components.

```tsx
import { defaultOverlays } from '@zyrox/react/overlays';
<ZyroxProvider overlays={defaultOverlays} …>
```

```jsonc
"press": [{ "do": "sheet", "screen": "sheets/address", "params": { "mode": "edit" }, "size": "half",
            "onClose": [{ "do": "refresh", "data": "addresses" }] }]
// inside sheets/address: { "do": "closeSheet", "result": "{{ state.address }}" }

"press": [{ "do": "alert", "title": "Remove item?", "buttons": [
  { "label": "Cancel", "style": "cancel" },
  { "label": "Remove", "style": "destructive", "actions": [
    { "do": "removeFromCart", "productId": "{{ item.id }}" },
    { "do": "toast", "message": "Removed", "action": { "label": "Undo", "actions": [{ "do": "addToCart", "productId": "{{ item.id }}" }] } }
  ] } ] }]
```

Your backend can open the same overlays, redirect and more: with `$actions` in any API response, messages over SSE / WebSocket / push, and event-trigger rules. See [UI from your backend](backend-ui.md).

## 12. Navigation

Zyrox doesn't own navigation; your router does. `navigate(to, params, { presentation, transition })` receives document keys (or any name you choose):

```tsx
// Expo Router: app/screen/[key].tsx renders <ZyroxScreen screen={key} params={params} />
navigate={(to, params, { presentation }) =>
  presentation === 'replace' ? router.replace({ pathname: '/screen/[key]', params: { key: to, ...params } })
  : router.push({ pathname: presentation === 'modal' ? '/modal/[key]' : '/screen/[key]', params: { key: to, ...params } })}

// React Navigation
navigate={(to, params, o) => (o.presentation === 'replace' ? navigation.replace : navigation.navigate)('Zyrox', { screen: to, params })}

// React Router / Next.js
navigate={(to, params) => routerNavigate(`/s/${to}?${new URLSearchParams(params as Record<string, string>)}`)}
```

Map names to native screens freely: `to === 'cart'` can open your native cart. The example apps do exactly that.

## 13. Remote functions

`{ "do": "call", "fn": "applyCoupon", "args": { "code": "{{ state.code }}" }, "into": "quote" }` runs a function registered on the Zyrox server: code in the server process, or a signed webhook to your cloud (Lambda, Cloud Run, Workers). See [self-hosting → functions](self-hosting.md#remote-functions). To route calls yourself (Firebase callable functions, your gateway), pass `callFunction={(fn, args, ctx) => …}` to the provider.

## 14. Languages

```jsonc
{ "type": "Text", "props": { "text": "{{ t('cart.items', { count: app.cart.count }) }}" } }
```

Messages use ICU syntax: `"{count, plural, =0 {Empty} one {# item} other {# items}}"`, `"{role, select, admin {Admin} other {Member}}"`.

Sources, merged in this order (later wins):

1. **Bundled**: `strings={{ en: {...}, hi: {...} }}` (works offline).
2. **Remote**: translation documents edited in the dashboard, fetched per locale and cached by content hash. Or your own source: `loadStrings={(locale) => fetch(...)}`.
3. **Runtime**: `useI18n().addMessages(locale, messages)`, and machine translation of missing keys:
   - by default, the server's translation provider when it has runtime translation on (batched, kept on the device until the source strings change);
   - or any model you choose, e.g. on device:

```ts
import { splitMessage } from '@zyrox/core';
<ZyroxProvider translateMissing={async ({ source, locale, sourceLocale }) => {
  if (!source) return null;
  const parts = splitMessage(source);                      // protects {placeholders} and plural branches
  return parts.join(await onDeviceModel.translate(parts.texts, sourceLocale, locale)); // null if a token broke
}} />
```

Switch at runtime from documents (`{ "do": "setLocale", "locale": "hi" }`) or code (`useI18n().setLocale('hi')`), or control it with the provider's `locale` prop. `format.*` helpers follow the active locale; `{{ i18n.direction }}` gives `rtl` for right-to-left languages.

## 15. Motion and transitions

Documents describe intent (`"motion": { "enter": "fade", "exit": "fade", "layout": true }`, `"transition": "slide"` on navigate); your adapter decides how. Zyrox never animates by itself.

```tsx
import Animated, { FadeIn, FadeOut, SlideInDown, LinearTransition } from 'react-native-reanimated';

const reanimatedMotion: MotionAdapter = {
  presets: ['fade', 'slideUp'],
  Item: ({ motion, visible, children }) =>
    visible ? (
      <Animated.View entering={motion.enter === 'slideUp' ? SlideInDown : FadeIn} exiting={FadeOut}
                     layout={motion.layout ? LinearTransition : undefined}>{children}</Animated.View>
    ) : null,
};
```

On the web, map presets to CSS or Framer Motion (`Group` can be `AnimatePresence`). Presets an adapter doesn't know are ignored.

## 16. Analytics, logging and error tracking

Observers receive every runtime event. Use one per tool:

```ts
const segment: Observer = (e) => {
  if (e.type === 'screen_view') analytics.screen(e.screen, { version: e.version, ...e.params });
  if (e.type === 'track') analytics.track(e.name, { ...e.props, screen: e.screen });
  if (e.type === 'exposure') analytics.track('Experiment Viewed', { experiment: e.experiment, variant: e.variant });
};
const sentry: Observer = (e) => {
  if (e.type === 'error') Sentry.captureMessage(`[zyrox] ${e.kind}: ${e.message}`, { extra: e });
};
const apm: Observer = (e) => {
  if (e.type === 'data_load') metrics.timing('zyrox.data', e.durationMs, { key: e.key, ok: e.ok, cached: e.cached });
};
```

| Event | When |
| --- | --- |
| `screen_view` | A screen mounted (with params) |
| `screen_load` | Time to render and where the document came from (`snapshot`, `cache`, `network`, `bundled`, `inline`) |
| `data_load` | A data source finished (`durationMs`, `ok`, `status`, `cached`) |
| `action` | An action finished (`durationMs`, `ok`) |
| `track` | A document's `track` action |
| `exposure` | The user saw a screen in an experiment |
| `error` | `expression`, `action`, `data`, `render`, `unknown_component` or `document` errors, with `nodeId` |
| `log` | Debug output (`debug` mode) |

Every event has `screen`, `version`, `nodeId`, the node's `meta` and `time`. Render errors are contained per node by error boundaries; the rest of the screen keeps working. With a server, views and errors are also aggregated into the dashboard's Health page.

## 17. Caching, offline and performance

What happens by default:

| Layer | Behaviour |
| --- | --- |
| Bootstrap | Cached for the environment TTL (default 60 s), revalidated with an ETag (`304` when unchanged), refreshed on foreground |
| Documents | Immutable, downloaded once and kept in storage; up to 4 prefetched in parallel after each bootstrap; versions no longer released are pruned |
| New versions | Downloaded in the background; the previous version stays on screen until ready, or if the download fails |
| Network | 15 s timeout, 2 retries with backoff and jitter (network errors, 5xx, 429); failed documents retried after 10 s |
| Data | Opt-in shared cache per data source (`"cache": seconds`), stale-while-revalidate |
| Telemetry | Aggregated counters, sent every 30 s and when the app goes to the background; kept while offline |

What you should do for production:

- **Storage**: on React Native use MMKV. It's synchronous, so cached screens render on the first frame with no loading state:
  ```ts
  const mmkv = new MMKV({ id: 'zyrox' });
  const storage = { getItem: (k) => mmkv.getString(k), setItem: (k, v) => mmkv.set(k, v), removeItem: (k) => mmkv.delete(k) };
  ```
  AsyncStorage works too (`storage={AsyncStorage}`), with one loading frame on a cold start. The web uses `localStorage` by default.
- **Snapshot**: bundle `npx zyrox snapshot --public-key "$ZYROX_PROD_KEY" --out src/zyrox.snapshot.json` (run in CI before building) so the first launch works offline.
- **Prefetch policy**: with many screens, create the client yourself and prefetch only the first few:
  ```ts
  const client = new ZyroxClient({ endpoint, publicKey, manifestHash: registry.manifest.hash, platform: Platform.OS, storage, prefetch: ['home', 'cart'] });
  <ZyroxProvider client={client} registry={registry} … />
  ```
  Other options: `timeoutMs`, `retries`, `retryDelayMs`, `telemetryInterval`.
- **Lists**: implement list components with `FlatList` / FlashList and pass `templates.item` as `renderItem`. Never `repeat` hundreds of nodes.
- **Images**: use a caching image component (expo-image, FastImage) with fixed sizes or aspect ratios.
- **Data cache**: add `"cache"` to catalog-like sources for instant back navigation. It's in memory and shared; create your own `new DataCache()`, pass it as `dataCache`, and call `.clear()` on sign-out.
- **Bundled screens**: `documents={…}` ships default versions of screens and sections in the app; the server overrides them once it has a release.

The runtime re-renders only the nodes whose inputs changed: typing in a bound field re-renders that field, not the screen. Expressions are parsed once per document. See the `zyrox-performance` Agent Skill for a longer checklist.

## 18. Previews: dashboard canvas and devices

**Your components in the dashboard canvas** (web): add a route that renders the preview host inside your provider, then set its URL as the project's Preview URL in Settings:

```tsx
import { ZyroxPreviewHost } from '@zyrox/react/preview';
// e.g. /__zyrox/preview. Only your dashboard may drive it: other sites could otherwise render
// documents with your users' credentials. Ship this route in development/staging builds only.
<ZyroxProvider registry={registry} fetcher={fetcher}>
  <ZyroxPreviewHost allowedOrigins={['https://ui.example.com']} />
</ZyroxProvider>
```

Without it the canvas shows labeled placeholders from the manifest.

**Live preview on devices:** the editor's Device button shows a QR code with `yourscheme://zyrox-preview?server=…&session=…&token=…`. Handle the link and render the live preview; edits appear as they're made:

```tsx
import { parsePreviewLink, ZyroxLivePreview } from '@zyrox/react/preview';
const link = parsePreviewLink(url);                       // from Linking (RN) or location.href (web)
if (link) return <ZyroxLivePreview {...link} onClose={() => …} />; // inside your provider
```

The preview tools live in `@zyrox/react/preview` so production bundles that don't import them don't include them.

## 19. Compatibility with older app builds

Old app builds stay in the wild for months. The rules that keep them working:

- **Props are additive.** Add optional or defaulted props. Never rename or remove a prop or change its type; create `ProductCard2` instead.
- **New components need a `fallback`** in documents until old builds are gone: `{ "type": "Carousel", …, "fallback": { "type": "List", … } }`.
- **Unknown action, helper or component** in an old build: the node falls back or the action reports an error; the screen keeps working.
- **Publishing checks** every document against each manifest that had traffic in the last 30 days and shows which builds would break, with their share of traffic. Release rules can target builds: `semver(client.app, '>=3.5')` or `client.manifest == 'm_…'`.

## 20. Security

- Documents never contain code. Expressions can't reach globals, prototypes or functions you didn't register.
- Requests go only through your fetcher, to `apiBaseUrl`'s origin or `allowedOrigins`. `openUrl` only opens `urlSchemes` (default https, http, mailto, tel).
- Public keys (`pk_…`) are read-only: they fetch released documents, call functions and send telemetry. Personal access tokens (`zyx_…`) are for CI and agents; never ship them in apps.
- Remote functions can't trust the user id the app reports. Pass `userToken` and verify it in the function.
- The preview host only accepts messages from `allowedOrigins`; don't ship the preview route in production builds.
- Documents are public and cacheable by CDNs: put no secrets or personal data in them. User data comes from your API at runtime.
- Treat `app` as data the document can read and render.
- Actions from your backend (`$actions`, messages, trigger rules) are limited to `remoteActions` (UI and navigation by default; never `request` or `call`), and their text is never evaluated as expressions. See [UI from your backend](backend-ui.md#security).

## 21. Testing

Render documents with Testing Library like any component:

```tsx
render(
  <ZyroxProvider registry={createRegistry({ components, actions })} fetcher={fakeFetcher} navigate={navigate} mock>
    <ZyroxScreen document={productDoc} params={{ id: 'p1' }} />
  </ZyroxProvider>,
);
fireEvent.click(screen.getByRole('button', { name: 'Add to cart' }));
expect(navigate).toHaveBeenCalledWith('cart', {}, { presentation: 'push' });
```

- `mock` makes data sources return their `mock`; leave it off and pass a fetcher to test real request flows.
- The example components run the same scenarios on web (React Testing Library) and native (React Native Testing Library) and compare behaviour: `examples/components/test/scenarios.ts`.
- In CI, `npx zyrox validate` checks documents in git against your manifest without a server.

## 22. CLI and CI

| Command | What |
| --- | --- |
| `zyrox login --token zyx_…` | Save a personal access token for a server |
| `zyrox whoami` | Show the user and projects |
| `zyrox manifest build [--out file]` / `manifest push [--label v]` | Build / upload this build's manifest |
| `zyrox pull [--dir zyrox]` | Download drafts as JSON files |
| `zyrox push [--publish] [--release dev,staging] [--message …]` | Upload files as drafts, optionally publish and release |
| `zyrox validate [files…]` | Validate local documents against the manifest |
| `zyrox snapshot --public-key pk_… [--out file]` | Offline snapshot to bundle in the app |
| `zyrox export [--versions] [--out file]` / `zyrox import <file> [--overwrite]` | Move a project between servers or projects ([headless](headless.md#export-and-import)) |
| `zyrox preview-token [--minutes 1440] [--documents a,b]` | Token for review builds and SSR draft mode ([draft previews](headless.md#draft-previews)) |
| `zyrox scaffold component <Name> [--prop …] [--event …]` | Definition plus web and native starter code |
| `zyrox skills install` / `skills rules` / `mcp` | Set up AI coding agents |

Global options: `--server`, `--project`, `--config` (or `ZYROX_SERVER`, `ZYROX_PROJECT`, `ZYROX_TOKEN`).

A typical app pipeline:

```yaml
- run: npx zyrox validate                                            # documents in git
- run: npx zyrox manifest push --label "${{ github.ref_name }}"      # this build's components
- run: npx zyrox snapshot --public-key "$ZYROX_PROD_KEY" --out src/zyrox.snapshot.json
- run: eas build …                                                    # or your web build
```

## 23. Reference

### `<ZyroxProvider>` props

| Prop | Type | Notes |
| --- | --- | --- |
| `registry` | `Registry` | Required |
| `endpoint` | `string` | Zyrox server URL |
| `publicKey` | `string` | Environment public key; required with `endpoint` |
| `appVersion` | `string` | For release rules |
| `user` | `string` | Stable id for rollouts/experiments; generated and stored if omitted |
| `attrs` | `Record<string, string \| number \| boolean>` | Targeting attributes |
| `userToken` | `() => string \| undefined \| Promise<…>` | Your user's token, forwarded to remote functions (`x-zyrox-user-token`) |
| `storage` | `{ getItem, setItem, removeItem }` | Sync or async; web defaults to `localStorage` |
| `snapshot` | `Snapshot` | From `zyrox snapshot` |
| `documents` | `Record<string, Document>` | Bundled screens, used when the server has none |
| `client` | `ZyroxClient` | Bring your own (options, sharing, tests) |
| `previewToken` | `string` | Show drafts instead of releases (review builds; [draft previews](headless.md#draft-previews)) |
| `fetcher` | `Fetcher` | Data sources and `request` |
| `apiBaseUrl` | `string` | Base for relative URLs |
| `allowedOrigins` | `string[]` | Extra origins for absolute URLs |
| `urlSchemes` | `string[]` | Schemes `openUrl` may open |
| `navigate` | `(to, params, { presentation, transition }) => void` | |
| `back` | `(result?) => void` | |
| `openUrl` | `(url) => unknown` | Defaults to the platform |
| `callFunction` | `(fn, args, ctx) => Promise<unknown>` | Defaults to the Zyrox server |
| `observers` | `Observer[]` | In addition to the registry's |
| `app` | `Record<string, unknown>` | `app` in documents |
| `locale`, `defaultLocale` | `string` | Controlled locale; source language |
| `strings` | `Record<locale, Messages>` | Bundled translations |
| `loadStrings` | `(locale) => Promise<Messages \| null>` | Your own remote source |
| `translateMissing` | `({ key, locale, source, sourceLocale }) => Promise<string \| null>` | Any translation model |
| `i18n` | `I18n` | Share an instance with non-Zyrox UI |
| `dataCache` | `DataCache` | Shared data source cache |
| `overlays` | `OverlayComponents` | `{ Sheet, Alert, Toasts, Message }` for `sheet`, `alert`, `toast` (`defaultOverlays` from `@zyrox/react/overlays`) |
| `remoteActions` | `string[]` | Actions your backend may trigger; default `DEFAULT_REMOTE_ACTIONS` ([backend UI](backend-ui.md#security)) |
| `mock` | `boolean` | Use data source mocks |
| `debug` | `boolean` | Log events, check props against schemas |

### `<ZyroxScreen>` props

`screen`, `document`, `version`, `params`, `loading`, `fallback`, `mock`, `onEvent`, `live`.

### Exports

| From | Exports |
| --- | --- |
| `@zyrox/react` | `ZyroxProvider`, `ZyroxScreen`, `createRegistry`, `definePlugin`, `implement`, `implementAction`, `defineComponent`, `extendComponent`, `defineAction`, `z`, `zx`, `useI18n`, `useZyrox`, `useZyroxActions`, `useScreenRuntime`, `useScreenState`, `ZyroxClient`, `DataCache`, `I18n`, `FetchError`, `DEFAULT_REMOTE_ACTIONS`, types (`Fetcher`, `Observer`, `ZyroxEvent`, `MotionAdapter`, `ZyroxComponentProps`, `OverlayComponents`, …) |
| `@zyrox/react/preview` | `ZyroxPreviewHost` (web), `ZyroxLivePreview`, `parsePreviewLink` |
| `@zyrox/react/overlays` | `defaultOverlays`, `createOverlays({ light, dark })` (web and React Native) |
| `@zyrox/react/remote` | `ZyroxRemote`, `sseSource`, `webSocketSource`, `pollSource`, `parseUiMessage`, `UiActionCenter` |
| `@zyrox/actions` | For your backend: `ui` builders, `withActions`, `uiMessage`, `trigger`, `UiChannel` (SSE), `toPushData`, validation, `uiJsonSchema` |
| `@zyrox/core` | The runtime without React: `ScreenRuntime`, `compileDocument`, `applyOps`, `ZyroxClient`, `fetchScreen` (SSR), `I18n`, `formatMessage`, `splitMessage`, `messageArgs`, … |
| `@zyrox/core/validate` | `validateDocument(doc, { manifest })` |
| `@zyrox/protocol` | Types, Zod schemas (`documentSchema`, `opSchema`, …), `buildManifest`, `defineComponent` |
