# Zyrox: Build Plan

A server-driven UI (SDUI) system for **React (web)** and **React Native**, with a server that delivers UI
and a dashboard to build, release and monitor it.

**Bring your own components.** Zyrox ships **no UI library**. Your design system stays yours. Any
React or React Native component can be driven from the server once you give it a schema. Zyrox provides
the protocol, the runtime (state, logic, actions, data, caching), delivery, and tooling.

The aim is to be the most capable SDUI stack available while staying simple. Each feature below sits
on a few shared primitives (one document format, one op format, one expression engine), not on extra
subsystems.

## Status

M0–M5 are built, tested and on the `claude/focused-franklin-ltiasx` branch. Beyond the plan, these
were added on request: motion and screen transitions, observers for any analytics/logging tool,
`extendComponent`, remote/cloud functions, translations (local, remote and runtime machine
translation with any model), the MCP design tools and Agent Skills, and the mobile caching layer
described in 6.2.

What changed from the plan, and why:

| Plan | Built | Why |
|---|---|---|
| jsep + own evaluator | Own parser and evaluator | Smaller, and dependency tracking for fine-grained updates comes for free |
| Better Auth | Own auth (scrypt passwords, sessions, `zyx_` personal access tokens) | Few needs (email/password, PATs, 4 roles); one less moving part |
| TanStack Router, shadcn/ui, dnd-kit | wouter, a small in-house UI kit, click-to-insert | Less code; the editor's needs are simple |
| `jsonb` for documents | `json` for drafts, versions and manifests | Keeps authored key order (prop order drives forms; diffs stay readable) |
| `bind`/`setState` paths from the root | Paths relative to `state` | Shorter documents, fewer mistakes |
| `size-limit` | `pnpm size` (Vite build, fully minified, gzipped) | Same budget, no extra tool. Now 18.6 KB |
| Preview tools in the main entry | `@zyrox/react/preview` | Production bundles don't ship them |
| Claude-only translation | `TranslationProvider` (Claude, DeepL, LibreTranslate, webhook, any plain-text model, custom) | Teams choose their model |

---

## 1. Goals and non-goals

### Goals
1. **Same runtime for web and native.** `@zyrox/react` runs in React DOM and React Native. Only your
   components differ per platform.
2. **Fully custom components.** You register components; Zyrox never renders anything of its own.
3. **Typed from one source.** You write a component's props once as a Zod schema. That one schema gives
   TypeScript types, dashboard forms, publish-time validation, and constraints for AI generation.
4. **Instant and offline.** Screens render from cache with no network wait after the first launch, and
   work in airplane mode.
5. **Safe releases.** Versions are immutable. You get environments, targeting, % rollouts, A/B
   experiments, one-click rollback, and error rates for each version.
6. **Old app versions never break.** The server knows which components each installed app build has. It
   validates before publishing, and documents carry fallbacks.
7. **Built for AI.** The dashboard can build or edit screens from a prompt or a screenshot. An MCP server
   lets coding agents edit screens. The protocol can stream agent-generated UI.

### Non-goals (guardrails against over-engineering)
- **No built-in UI kit, style system or theme engine.** These belong to your design system.
- **No code execution.** No downloaded JS and no `eval`. Documents are data; logic is a small sandboxed
  expression language plus actions you register.
- **No custom layout engine or binary format.** Layout is your components with Flexbox/CSS. Documents
  are gzip/brotli JSON.
- **No GraphQL, microservices, queues or event pipelines.** One server and one Postgres database.
- **No built-in analytics product.** Zyrox sends exposure and track events to *your* analytics.
- **No real-time multi-user editing in v1.** Drafts use optimistic locking. The op-based design leaves
  room to add it later.
- **No server-side business data in v1.** Zyrox serves *structure*. Your existing APIs serve *data*,
  which the client fetches with its own auth.

---

## 2. What makes it best-in-class (and why it stays simple)

| Capability | How it works | Why it's cheap |
|---|---|---|
| **Bring-your-own components** | `defineComponent` (schema) + `implement` (React/RN). Dashboard forms are generated from the schema | One Zod schema drives everything |
| **Zero-latency screens** | A small per-user **bootstrap** says which version of each screen to show. Documents are **immutable and content-addressed**, cached forever on the CDN and the device, and prefetched | Immutable files avoid all cache-invalidation logic |
| **Capability-aware publishing** | Each app build uploads a **manifest** (its components, props and actions). Before publishing, the server reports e.g. "breaks 12% of traffic (app ≤ 3.3), add a fallback" | Manifests are JSON blobs keyed by hash |
| **Reactive runtime** | Local state, expressions, actions, two-way binding. Each node subscribes only to the paths it reads, so only those nodes re-render | One small store plus dependency tracking in the evaluator |
| **One mutation language ("ops")** | Insert, update, remove and move nodes by id. Used for editor undo/redo, live device preview, AI edits, MCP edits and runtime streaming | Five operations, one apply function |
| **Live preview on a real device** | Scan a QR code; the device shows the draft and updates on every keystroke | A WebSocket relay that forwards ops |
| **Release control** | Rules are expressions (`client.platform == 'ios' && semver(client.app, '>=3.4')`). Rollout % and experiments use stable hash buckets | Reuses the expression engine |
| **AI building** | Prompt or screenshot → ops, constrained by *your* registry schemas and streamed into the preview | The registry's JSON Schema already exists; the AI only emits ops |
| **Agent access (MCP)** | Agents such as Claude Code can list components and read, edit and validate drafts | A thin wrapper over the admin API |

Ideas borrowed and combined:
- **A2UI:** separating the component tree from the data model, and streamable updates addressed by id.
- **DivKit:** a cross-platform expression language with variables and typed actions.
- **Builder.io / Plasmic:** registering your own code components in a visual editor.

---

## 3. Architecture

```
┌────────────────────────┐  edit ops / publish  ┌────────────────────────────────┐
│ Dashboard (Vite SPA)   │ ───────────────────▶ │ Zyrox Server (Hono, Node)      │
│ editor · releases ·    │ ◀── preview relay ─▶ │ admin API · delivery API ·     │
│ health · AI assistant  │      (WebSocket)     │ preview relay · MCP · telemetry│
└───────────┬────────────┘                      │ Postgres (Drizzle)             │
            │ iframe (your preview route)       └───────┬───────────────▲────────┘
            ▼                                   bootstrap│  immutable    │ telemetry
┌────────────────────────┐                     (per user)│  docs via CDN │ (batched)
│ Your app (web / RN)    │ ◀────────────────────────────┘               │
│ @zyrox/react runtime   │ ─────────────────────────────────────────────┘
│ + YOUR components      │ ── data requests (your auth) ──▶ Your APIs
│ + YOUR actions         │ ── exposure / track events ────▶ Your analytics
└────────────────────────┘
```

### Packages (pnpm monorepo)

```
zyrox/
  packages/
    protocol/   @zyrox/protocol  Document/node/action/op types, Zod schemas, JSON Schema export,
                                 defineComponent/defineAction, zx.* editor hints. No React.
    core/       @zyrox/core      Expression engine, store, action runner, document compiler,
                                 op applier, cache, bootstrap client. No React.
    react/      @zyrox/react     Renderer, registry, provider, hooks, preview host.
                                 Same code for React DOM and React Native.
    server/     @zyrox/server    Hono app: delivery + admin + preview relay + MCP + telemetry.
    cli/        @zyrox/cli       manifest push, snapshot, validate, pull/push documents.
  apps/
    dashboard/                   Vite + React SPA (served by the server in production).
  examples/
    web/                         Vite (or Next.js) app with a few example components.
    native/                      Expo app with the same example components (.native.tsx).
```

The example components live only in `examples/` as copy-paste starters. They are not a published package.

---

## 4. The protocol (v1)

### 4.1 Document

```jsonc
{
  "zyrox": 1,                                  // protocol major version
  "kind": "screen",                            // "screen" | "block"
  "key": "product",
  "params": { "id": { "type": "string", "required": true } },
  "state":  { "qty": 1, "form": { "note": "" } },
  "data": {
    "product": {
      "url": "/products/{{ params.id }}",      // fetched by YOUR fetcher with YOUR auth
      "refresh": ["mount", "focus"],
      "mock": { "name": "Sample", "price": 1999, "isNew": true }   // used by the dashboard
    }
  },
  "root": {
    "id": "n1", "type": "AppScreen",                       // ← your component
    "props": { "title": "{{ data.product.name }}" },
    "children": [
      { "id": "n2", "type": "ProductGallery",               // ← your component
        "props": { "images": "{{ data.product.images }}" } },

      { "id": "n3", "type": "Price",
        "props": { "amount": "{{ data.product.price }}", "size": "lg" } },

      { "id": "n4", "type": "Badge", "if": "{{ data.product.isNew }}",
        "props": { "label": "New" },
        "fallback": { "id": "n5", "type": "Label", "props": { "text": "New" } } },

      { "id": "n6", "type": "QuantityStepper",
        "props": { "min": 1 }, "bind": "state.qty" },       // two-way binding

      { "id": "n7", "type": "Button",
        "props": { "label": "Add {{ state.qty }} to cart", "loading": "{{ state.adding }}" },
        "on": { "press": [
          { "do": "setState", "path": "adding", "value": true },
          { "do": "addToCart", "productId": "{{ params.id }}", "qty": "{{ state.qty }}" },  // your action
          { "do": "track", "event": "add_to_cart" },
          { "do": "navigate", "to": "cart" }
        ] } },

      { "id": "n8", "type": "ProductList",
        "props": { "items": "{{ data.related }}", "columns": 2 },
        "templates": { "item": { "id": "n9", "type": "ProductCard",
                                 "props": { "title": "{{ item.name }}", "image": "{{ item.thumb }}" } } } }
    ]
  }
}
```

Forms declare validation next to their state (`"forms": { "form": { "fields": { "note": { "required": true, "maxLength": 200 } } } }`).
Rules (`required`, `minLength`, `maxLength`, `min`, `max`, `pattern`, `email`, `url`, `oneOf`, `equals`,
custom `rules`, conditional `if`) may be expressions; the runtime re-checks them when anything they read
changes, publishes `forms.<name>` (`valid`, `errors`, `shown`, `touched`, `submitted`), passes `error` /
`required` to bound components, and the `validate`, `resetForm` and `setErrors` actions gate submission and
show API field errors.

Overlays are built-in actions: `sheet` (a document by key, an inline document, or plain content),
`closeSheet`, `alert` (waits for a button; each button carries its own actions) and `toast`. The app
supplies their components (`overlays`; defaults in `@zyrox/react/overlays`).

**UI from any backend** (`docs/backend-ui.md`) reuses the same actions without the Zyrox server:
`$actions` in any API response or error body, messages (`{ id, actions, triggers, expiresAt }`) over
SSE / WebSocket / push / polling / custom transports, and trigger rules (`on` screen_view / track /
app_open / foreground, `if` expression, `once` / `cooldown` / `maxPerSession` / `delay`) evaluated on the
device. Backend actions are limited to an allowlist (`remoteActions`, UI and navigation by default) and
taken literally (no expressions, except in trigger rules). `@zyrox/actions` is the zero-dependency
backend SDK (builders, validation, SSE hub, push data) and ships a JSON Schema for other languages.

### 4.2 Node

| Field | Meaning |
|---|---|
| `id` | Stable, unique within the document. Ops, selection, telemetry and AI edits all address nodes by id |
| `type` | A component name from your registry |
| `props` | Values that are literals or expressions |
| `children` | Default slot |
| `slots` | Named slots (`header`, `footer`, …), as rendered nodes |
| `templates` | Item templates rendered by *your* component (e.g. a virtualized list): the component receives `renderItem(item, index)` |
| `on` | Event name → list of actions |
| `bind` | Two-way binding to a state path. The component declares which prop/event pair it binds |
| `if` | Render only when the expression is truthy |
| `repeat` | `{ "each": expr, "as": "item", "key": expr }` for small lists (use `templates` for long ones) |
| `fallback` | Node to render when the client doesn't have `type` (older app builds) |
| `a11y` | Optional `label` / `hint` / `role`, passed to your component as props |

### 4.3 Values and expressions
- A plain JSON value is a literal.
- A string that is *exactly* `"{{ expr }}"` evaluates to the typed result (number, bool, object, …).
- A string that mixes text and `{{ }}` is interpolated into a string.
- The language is a **JS expression subset**: literals, member access, arithmetic, comparison,
  `&& || ?? !`, ternary, array/object literals, and calls to whitelisted helpers only. No assignment,
  loops, lambdas, globals, or `__proto__`/`constructor` access. AST size is capped.
- Built-in helpers: `len`, `upper`, `lower`, `trim`, `includes`, `join`, `coalesce`, `format.number`,
  `format.currency`, `format.date`, `semver`. Hosts can register their own (e.g. `t()` for i18n).
- Scope: `params`, `state`, `data`, `loading`, `error`, `forms`, `event` (inside actions), `item`/`index`
  (inside repeat/templates), `app` (host-provided context such as the user or feature flags), and
  `device` (`platform`, `width`, `height`, `colorScheme`, `locale`).
  Responsive layouts need no separate feature: `"{{ device.width > 768 ? 'row' : 'column' }}"`.
- Implementation: our own small parser (no `eval`, Hermes-safe) and a walker that records which scope
  paths were read (used for fine-grained subscriptions).

### 4.4 Actions
Actions are data. A list of actions runs in order and awaits each one. On error the list stops and the
error goes to telemetry plus any `onError` list.

| Action | Args |
|---|---|
| `setState` | `path`, `value` |
| `navigate` / `back` | `to`, `params`, `replace?`. Delegated to the host's router |
| `openUrl` | `url` (scheme allowlist) |
| `request` | `url`, `method`, `body`, `into?` (state path), `onSuccess`, `onError`. Goes through the host fetcher; base-URL allowlist |
| `refresh` | `data?`: re-fetch one or all data sources |
| `track` | `event`, `props`. Forwarded to the host's `onTrack` |
| `if` | `cond`, `then`, `else` |
| *your actions* | Any name in your registry; args validated by its Zod schema |

### 4.5 Ops (the one mutation language)

```jsonc
{ "op": "insert", "parent": "n1", "slot": "children", "index": 2, "node": { ... } }
{ "op": "update", "id": "n7", "set": { "props.label": "Buy now" } }
{ "op": "remove", "id": "n4" }
{ "op": "move",   "id": "n6", "parent": "n1", "slot": "children", "index": 0 }
{ "op": "doc",    "set": { "state.qty": 2 } }       // edit document-level fields
```

Ops address nodes by id, not by array index, so they don't break when siblings move. That makes them
safe for concurrent edits and easy for LLMs to stream. The same ops are used by editor undo/redo
(inverse ops), live preview, AI edits, MCP, and runtime streaming.

### 4.6 Compatibility rules (kept simple)
- **Protocol major mismatch:** the client ignores the document and renders the last good cached version
  or the bundled snapshot.
- **Unknown component:** the client renders `fallback` if present, otherwise nothing, and sends a telemetry event.
- **Unknown props** are ignored.
- **Component evolution:** props are **additive only**. A breaking change means a new component name
  (`ProductCard2`). There is no per-component version negotiation.
- Validation runs **at publish time on the server** (against manifests) and **in dev builds on the
  client**. Production clients skip Zod parsing for speed.

---

## 5. Your components and actions (the registry)

### 5.1 Define once, implement per platform

```ts
// components/product-card/def.ts   (pure: no React, importable by the CLI in Node)
import { defineComponent, z, zx } from '@zyrox/protocol';

export const ProductCardDef = defineComponent({
  name: 'ProductCard',
  description: 'Product tile with image, title and price',   // shown in dashboard + given to AI
  props: z.object({
    title: z.string(),
    image: zx.image(),                                          // editor hint: image picker
    price: z.number().optional(),
    tone: z.enum(['default', 'promo']).default('default'),      // your design tokens as enums
  }),
  events: { press: z.object({}) },
  slots: { footer: 'node' },
});
```

```tsx
// components/product-card/ProductCard.tsx         (web, your design system)
// components/product-card/ProductCard.native.tsx  (RN, picked automatically by Metro)
import { implement } from '@zyrox/react';
import { ProductCardDef } from './def';

export const ProductCard = implement(ProductCardDef, ({ title, image, price, tone, onPress, slots }) => (
  <MyCard tone={tone} onPress={onPress}>
    <MyImage src={image} />
    <MyText>{title}</MyText>
    {slots.footer}
  </MyCard>
));
```

If your design system is already cross-platform (Tamagui, NativeWind, Unistyles, react-native-web),
one file serves both platforms.

Two more definition options cover the remaining cases:
- `templates: ['item']`: the component receives `templates.item(item, index)`, so you can wrap
  `FlatList`, FlashList or a web virtualizer yourself.
- `bind: { prop: 'value', event: 'change' }`: makes a component bindable with `"bind": "state.x"` in
  documents (inputs, toggles, steppers).

`zx.*` helpers are ordinary Zod schemas with editor metadata, not a design system: `zx.image()`,
`zx.color()`, `zx.url()`, `zx.multiline()`.

### 5.2 Actions and the registry

```ts
export const AddToCartDef = defineAction({
  name: 'addToCart',
  args: z.object({ productId: z.string(), qty: z.number().int().min(1) }),
});

export const registry = createRegistry({
  components: [ProductCard, AppScreen, Button, ProductList /* … all yours */],
  actions: [implementAction(AddToCartDef, async ({ productId, qty }, ctx) => cart.add(productId, qty))],
  helpers: { t: i18n.t },               // optional expression helpers
});
```

### 5.3 Manifest
`zyrox manifest push` (run in CI for every app build) imports your `def.ts` files and uploads:

```jsonc
{ "hash": "sha256:9f2c…", "protocol": 1,
  "components": { "ProductCard": { "props": { /* JSON Schema */ }, "events": ["press"], "slots": ["footer"], "templates": [] } },
  "actions":    { "addToCart": { "args": { /* JSON Schema */ } } },
  "helpers": ["t"] }
```

The app sends the manifest hash on every bootstrap. The server then knows exactly what each installed
build supports, which is enough for compatibility reports. No app-version bookkeeping is needed.

---

## 6. Client runtime (`@zyrox/core` + `@zyrox/react`)

### 6.1 Setup

```tsx
<ZyroxProvider
  endpoint="https://ui.example.com"
  publicKey="pk_prod_…"
  registry={registry}
  storage={mmkvAdapter}                 // { get, set, remove }; localStorage default on web
  fetcher={authedFetch}                 // used for document data sources + request action
  navigate={(to, params, opts) => router.push(...)}   // Expo Router, React Navigation, Next, React Router…
  onTrack={(e) => analytics.track(e.name, e.props)}
  context={{ user, flags }}             // exposed as `app` in expressions
  user={installOrUserId}                // stable id for rollout/experiment bucketing
  snapshot={bundledSnapshot}            // first-launch/offline fallback (from `zyrox snapshot`)
>
  <ZyroxScreen screen="product" params={{ id }} loading={<MySkeleton />} />
</ZyroxProvider>
```

### 6.2 Delivery flow
1. **Bootstrap** (app start, foreground, every `ttl`): `GET /v1/bootstrap` returns the screen → version
   ref map for this user and their experiment assignments. The response is tiny and personalized.
2. **Documents**: `GET /v1/docs/{contentHash}`. Immutable, `Cache-Control: immutable`, served from
   the CDN and kept in device storage forever (LRU-trimmed).
3. **Prefetch** referenced documents after bootstrap (4 at a time; policy `all`, `none` or a key list),
   so navigation never waits on the network. Versions no longer released are pruned from storage.
4. **Stale-while-revalidate**: always render what's cached and switch to the new version on the next
   mount, not mid-interaction. While a new version downloads, or if it fails, the previous one keeps
   showing (`stale: true`).
5. A **bundled snapshot** covers the very first launch with no network.
6. **Revalidation is cheap**: the bootstrap carries an ETag; unchanged → `304`. Documents are served
   precompressed (Brotli/gzip).
7. **Flaky networks**: 15 s timeouts, 2 retries with exponential backoff and jitter (network errors,
   5xx, 429), failed documents retried after a cooldown, telemetry kept while offline and flushed when
   the app goes to the background.
8. **First frame**: with synchronous storage (MMKV, localStorage) the client hydrates in its
   constructor, so cached screens render without a loading state.
9. **Data sources** can opt into a shared stale-while-revalidate cache (`"cache": seconds`) for instant
   back navigation.

Publishing a change therefore reaches users within one bootstrap TTL (default 60 s). Rollback works
the same way.

### 6.3 Rendering
- `compile(document)` runs once per version: it indexes nodes by id, pre-parses every expression to
  an AST, and splits static from dynamic props.
- `<NodeView>` evaluates only the node's dynamic props and subscribes, via `useSyncExternalStore`, to
  just the paths those expressions read. Changing `state.qty` re-renders only the nodes that use it.
- Each node has an error boundary. A broken node renders its `fallback` or nothing; the screen survives.
- Data sources: fetched in parallel on mount through the host fetcher. Results go to `data.*`;
  `loading.*` and `error.*` are available to `if` conditions.
- Web SSR: `<ZyroxScreen document={doc} />` accepts a pre-fetched document, so Next.js can render it
  on the server.

### 6.4 Preview host
`<ZyroxPreviewHost registry={registry} />` (from `@zyrox/react/preview`) is a route you mount in your
web app or Expo web build. The dashboard loads it in an iframe and sends it documents, mock data and
selection over `postMessage`. It reports clicks/hovers and node bounding boxes back to the dashboard.
Components your preview host can't render show as labelled placeholders, and the real device preview
(QR) covers them.

### 6.5 Telemetry
Batched every 30 s and when the app goes to the background: `view`, `render_error`,
`unknown_component`, `action_error`, `expr_error`, each tagged with screen, version and node id. Stored
as daily counters, not raw events.

### 6.6 Security
- Documents never contain code; expressions are sandboxed and size-limited.
- Only registered actions can run. `openUrl` uses a scheme allowlist; `request` uses a base-URL
  allowlist and always goes through your fetcher (your auth).
- **Documents are public by design** (they ship to every client), so never put secrets in them.
  Personal data comes from your APIs at runtime.
- No executable code is downloaded. Documents are data rendered by components already compiled into
  the app binary.

### 6.6b Headless integration
The admin API is versioned at `/api/v1` and described by an OpenAPI 3.1 document (`/api/v1/openapi.json`,
kept complete by a test). Every audited change is also an outbound webhook event (signed like webhook
functions, SSRF-protected, retried 10 s / 1 min / 5 min, logged per webhook). `GET /v1/screens/:key` returns
one screen for a user in a single request for server-side rendering (`fetchScreen` in `@zyrox/core`).
Draft preview tokens (stateless, HMAC-signed with the server secret, expiring, optionally per document)
make the bootstrap and screens endpoints serve drafts, compiled with draft blocks and content-addressed
like versions; clients with a token skip storage and telemetry. Projects export to one JSON file (drafts,
optional history and releases, settings without secrets) and import into any project.

### 6.7 Size budget
`@zyrox/core` + `@zyrox/react` ≤ **24 KB gzipped** (fully minified), enforced in CI with
`pnpm size`; currently 23.4 KB (raised from 20 KB for form validation, overlays and backend-triggered
actions). Opt-in parts ship as separate entries: `@zyrox/react/overlays` (default sheet, alert and toast
components) and `@zyrox/react/remote` (streams and trigger rules). Zod is used only in dev builds and on the server.

---

## 7. Server (`@zyrox/server`)

### 7.1 Data model (Postgres + Drizzle)

| Table | Purpose |
|---|---|
| `projects`, `environments` | One project per app; environments `dev`/`staging`/`prod`, each with a public key |
| `documents` | One row per screen or block: key, name, kind |
| `drafts` | Working copy per document: JSON plus `revision` (optimistic locking) |
| `versions` | **Immutable** published versions: compiled JSON, source JSON, content hash, message, author |
| `releases` | Per environment and document: an ordered rule list → version / experiment / rollout % |
| `experiments` | Variants → versions, weights, status |
| `manifests`, `manifest_traffic` | Uploaded manifests and daily request counts per hash |
| `telemetry_daily` | (env, version, event type, day) → count |
| `users`, `sessions`, `api_tokens`, `members` | Own auth; roles `viewer` / `editor` / `publisher` / `admin` |
| `audit_log` | Every publish, release change and rollback, with a diff |

### 7.2 Delivery API (public, read-only, CDN-friendly)

```http
GET /v1/bootstrap
Authorization: Bearer pk_prod_…
X-Zyrox-Client: platform=ios; app=3.4.1; manifest=9f2c…; protocol=1
X-Zyrox-User: anon_8c1…
X-Zyrox-Attrs: country=IN; plan=pro          # optional targeting attributes

200 { "ttl": 60,
      "docs": { "home": "sha256-ab12…", "product": "sha256-77f0…" },
      "experiments": [{ "key": "home-hero", "variant": "b" }] }

GET /v1/docs/sha256-ab12…                     # immutable, cache forever
POST /v1/telemetry                            # batched counters
```

Bootstrap logic for each document: evaluate the release rules in order (rules are expressions over
`client`, `attrs`, `user`). The first match yields a version, a rollout bucket
(`hash(user + rule) % 10000`), or an experiment variant. Published documents are cached in an
in-memory LRU, so bootstrap is a few map lookups.

### 7.3 Publish = compile
1. Validate the structure (protocol schema).
2. Expand **blocks** (reusable parameterised fragments) inline. Clients never see blocks.
3. Validate every node's props, events, actions and helpers against the **latest manifest**. Parse every
   expression.
4. **Compatibility report** against manifests that had traffic in the last 30 days, for example:
   "`Badge` is missing on 12% of traffic and has no `fallback`". Errors block publishing; warnings show
   the affected traffic.
5. Store an immutable version under its content hash.

### 7.4 Preview relay
`POST /admin/preview-sessions` returns a session id and a QR deep link. The dashboard and devices join a
WebSocket room. The dashboard sends ops (debounced at 100 ms) and devices apply them. The relay is
in-memory; use Postgres `LISTEN/NOTIFY` if more than one server instance runs.

### 7.5 MCP endpoint
`/mcp` (Streamable HTTP, stateless, official MCP TypeScript SDK, authenticated with a personal access
token). Modeled on design-tool MCP servers, so agents can design with the app's real components:

- Design system: `list_components`, `get_component`, `get_component_map` (code location, screens
  using it, support across app builds), `get_variable_defs` (tokens, motions, transitions),
  `create_design_system_rules` (a rules file for the repository).
- Screens: `list_documents`, `get_design_context` (draft, components used with signatures and code
  paths, data, problems), `create_document`, `apply_ops` (drafts only, optimistic locking),
  `validate_document` (with the affected app builds), `create_preview_link` (devices update live).
- Code and data: `scaffold_component`, `upload_manifest`, `list_functions`, `test_function`.
- Guides: `get_guide` and the Agent Skills as resources.

Tools call the admin API in-process, so roles and validation are identical to the dashboard.
**Publish and release are not exposed**; a human does those in the dashboard. `@zyrox/skills` ships
the Agent Skills (`npx zyrox skills install`).

### 7.6 Deployment
A single Docker image runs the API, serves the dashboard, and handles WebSockets. It needs Postgres.
Put a CDN in front of `/v1/docs/*` and `/v1/strings/*`. Configuration: `DATABASE_URL`,
`ZYROX_PUBLIC_URL`; optionally `ANTHROPIC_API_KEY` (assistant, default translator), `ZYROX_TRANSLATOR`
(`claude`, `deepl`, `libretranslate`, `webhook`, `off`) with `ZYROX_TRANSLATOR_URL`/`_KEY`, and
`ZYROX_RUNTIME_TRANSLATION`. Tests and the local quickstart use **PGlite** (in-process Postgres), so no Docker
is needed to try it.

---

## 8. Dashboard (`apps/dashboard`)

### 8.1 Pages
- **Documents:** screens and blocks, with live version per environment and an unpublished-changes badge.
- **Editor** (see below).
- **History:** versions, visual and JSON diff, restore to draft.
- **Releases:** per environment, rule table, rollout slider, **Rollback** and kill switch, promote
  staging → prod.
- **Experiments:** variants → versions, weights, start/stop, exposure counts.
- **Components:** registry browser built from manifests: props, which app builds support each
  component, and where it is used.
- **Health:** views and error rates per document version; app-build adoption (traffic by manifest).
- **Settings:** environments, keys, members and roles, preview URL, AI settings, audit log.

### 8.2 Editor layout
- **Left:** outline tree (drag/drop with dnd-kit, search) and an insert palette listing *your* components
  with their descriptions.
- **Center:** canvas, an iframe of *your* preview route. It has device-size presets, light/dark mode,
  mock or live data, and an **Open on device** QR code.
- **Right:** inspector tabs:
  - **Props:** a form generated from the component's JSON Schema. Every field has an `ƒx` toggle for an
    expression input that autocompletes state/data paths from the mocks.
  - **Events:** action builder (your actions are listed with typed args).
  - **Logic:** `if`, `repeat`, `bind`, `fallback`.
  - **A11y.**
  - **JSON:** this node only.
- **Bottom drawer:** state and data sources (with mock JSON), Problems (live validation), AI chat.
- **Full JSON mode:** Monaco with the generated JSON Schema, giving autocomplete and squiggles for free.
- Undo/redo uses inverse ops. Drafts autosave and keep their revision for conflict detection.

Schema → widget mapping: string → text, number → number/slider, boolean → switch, enum → select,
`zx.image` → URL/picker, `zx.color` → color picker, object → group, array → list editor.

### 8.3 AI assistant
- **Prompt → screen/edit** ("add a reviews section under the price"), **screenshot → screen**, and
  **explain/fix validation errors**.
- The server calls the Claude API (default model `claude-opus-5-5`, configurable) with your component
  catalog (descriptions + JSON Schemas) in a cached system prompt. The model returns **ops** through
  tools marked `strict: true`. The tool list stays flat (insert/update/remove/move); there is no
  recursive whole-document schema.
- Ops stream into the canvas as they arrive. Every op is re-validated with Zod before it is applied.
  The result is an ordinary draft change: undoable, and reviewed before publishing.
- Adaptive thinking, streaming with eager tool input, and server-side refusal fallbacks on the
  models that support them.
- **Translations** use a pluggable provider (Claude by default). The same provider serves the
  dashboard's "Translate missing" and, when enabled, runtime translation in apps (`/v1/translate`:
  keys only, so the public key can't be used to translate arbitrary text; cached, rate limited).
  Results whose placeholders differ from the source are dropped.

---

## 9. Tech stack

| Area | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) everywhere | One type system from protocol to dashboard |
| Monorepo | pnpm workspaces + Turborepo | Standard, cached builds |
| Lint/format | Biome | One fast tool instead of ESLint + Prettier |
| Lib builds | tsdown (protocol, core); TypeScript sources elsewhere | ESM + types, fast |
| Schemas | Zod 4 | TS types + native JSON Schema export from one source |
| Expressions | Own parser + evaluator | Tiny, no `eval`, works on Hermes, tracks dependencies |
| Client | React ≥ 18, React Native New Architecture, Expo supported | Same renderer on both |
| Server | Hono on Node 22+ | Small, fast, standard Request/Response, WebSockets |
| DB | Postgres + Drizzle (PGlite in tests/dev) | `json` documents, typed queries, easy local setup |
| Auth | Own (scrypt, sessions, personal access tokens) | Small surface, no extra service |
| Dashboard | Vite, React 19, wouter, TanStack Query, Tailwind, Monaco | Proven, fast to build |
| AI / agents | Anthropic TypeScript SDK; MCP TypeScript SDK | Strict tool use, streaming; standard agent access |
| Tests | Vitest, React Testing Library, Jest + RNTL (native), Playwright | Standard per layer |
| CI | GitHub Actions | Typecheck, lint, test, size budget, e2e |

---

## 10. Milestones

Durations assume 2–3 engineers. Each milestone has an exit criterion that must be demonstrated.

| # | Milestone | Scope | Exit criterion |
|---|---|---|---|
| **M0** | Foundations (1 wk) | Monorepo, CI, Biome, protocol spec + Zod schemas, ~20 golden fixture documents (valid and invalid) | Fixtures validate; JSON Schema export works |
| **M1** | Runtime (3 wks) | `core` (expressions, store, actions, compile, ops) + `react` (renderer, registry, `implement`, bind, slots, templates, error boundaries). Example apps (web + Expo) with ~8 example components rendering fixtures from local files | The same fixtures behave identically on web, iOS and Android; a 1,000-item templated list scrolls smoothly on a mid-range Android device; bundle ≤ 20 KB gz |
| **M2** | Server + delivery (2 wks) | Hono + Drizzle, documents/drafts/versions/releases, bootstrap + immutable docs, CLI (`manifest push`, `snapshot`, `validate`), client cache/SWR/prefetch/offline, telemetry ingest | Changing a doc via the admin API updates the app within 60 s with no release; a launch in airplane mode renders the last good UI |
| **M3** | Dashboard MVP (4 wks) | Auth/roles, documents list, editor (tree, iframe canvas, generated props forms, action builder, JSON mode, mocks, problems panel), publish/diff/rollback, preview host, QR live device preview | A non-engineer builds and ships a screen from existing components in under 15 minutes |
| **M4** | Release control (2 wks) | Environments + promotion, targeting rules, % rollouts, experiments, blocks, compatibility report, health page, audit log, `zyrox pull/push` (screens in git, validated in CI) | Rollout 5% → 100% with one-click rollback; exposure events arrive in the host's analytics |
| **M5** | AI + agents (2 wks) | AI assistant (prompt/screenshot → ops, fix errors), MCP endpoint | "Build a product page with gallery and add-to-cart" yields a valid, previewable draft; Claude Code edits drafts via MCP |

About 14 weeks to a complete v1.

**Later, only when users ask:** asset uploads (S3-compatible), real-time multi-user editing (on top
of ops), automatic rollback on error spikes, `<ZyroxSurface>` for agent-streamed UI at runtime,
server-side data resolvers (BFF mode), Figma import, an A2UI adapter, an app flow editor (screens as a
graph with `navigate` actions as edges).

---

## 11. Quality and testing
- **Golden fixtures** shared by every package: the protocol, the runtime, and server validation all
  test against the same documents.
- **Parity tests:** render each fixture with RTL (web) and RNTL (native) and compare the
  **accessibility trees** (text, roles, states). This catches behavioral drift without screenshot
  infrastructure.
- **Security tests** for the evaluator: prototype access, global access, oversized and deeply nested
  ASTs.
- **Server integration tests** on PGlite: publish → bootstrap → doc fetch → rollback.
- **E2E** (Playwright): create → edit → preview → publish → example web app shows it.
- **Budgets in CI:** bundle size, `compile()` time for a 500-node document, re-render count when one
  state path changes.

---

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Dashboard editor scope creep | Generated forms + JSON mode first; canvas polish after M3 |
| Expression language grows into a programming language | Strict whitelist; complex logic belongs in your actions and components |
| Old app builds break | Additive-only props, `fallback`, publish-time compatibility report based on real traffic |
| Previewing custom components in the browser | Your preview route in the iframe; placeholders; real-device QR preview |
| Low-end Android performance | Precompiled docs, per-path subscriptions, templates for virtualized lists, perf budgets in CI |
| Remote content abuse | No code, sandboxed expressions, allowlisted actions/URLs/hosts, read-only public keys |

---

## 13. Open decisions
1. **Distribution:** self-hosted open source only (as planned), or also a hosted multi-tenant SaaS later?
2. **License:** MIT, or open-core (e.g. experiments/AI as paid)?
3. **Minimum platforms:** Expo-first with bare React Native also supported (as planned)? Web: Next.js
   SSR support in M1 or later?
4. **Team and timeline:** the milestones above assume 2–3 engineers.
