# Zyrox

Server-driven UI for **React** and **React Native**, with a server that delivers it and a dashboard to build, release and monitor it.

**Bring your own components.** Zyrox ships no UI kit. You register your own React / React Native components with a schema; screens are JSON documents that use them. Change a screen, publish, and every app build that supports it shows the new version within a minute, without an app store release.

```
┌──────────── Your app (web / iOS / Android) ────────────┐        ┌──────── Zyrox server ────────┐
│ <ZyroxProvider registry={yourComponents} endpoint=…>   │  GET   │ /v1/bootstrap  (per user)    │
│   <ZyroxScreen screen="home" />   ← JSON documents     │◄──────►│ /v1/docs/<hash> (immutable)  │
│   your fetcher → YOUR API (data, auth, cart…)          │        │ admin API + dashboard + MCP  │
└────────────────────────────────────────────────────────┘        └──────────────────────────────┘
```

## What you get

- **Runtime** (`@zyrox/react`, ~23 KB gzipped): renders documents with your components on web and native, with state, two-way binding, declarative form validation, expressions, actions, sheets / alerts / toasts, data sources, templates for virtualized lists, motion, accessibility, error boundaries per node, and observers for any analytics or logging tool.
- **Delivery built for mobile**: content-addressed documents cached forever, ETag-revalidated bootstrap, offline snapshot, the previous version shown while a new one downloads, retries and timeouts, first-frame rendering from MMKV/localStorage.
- **Release control**: environments, publish = validate + compile, targeting rules, percentage rollouts, experiments, rollback, compatibility report against the app builds in use, health per version, audit log.
- **Dashboard**: visual editor with your real components in the canvas, live preview on devices (QR), generated property forms, action builder, JSON mode, translations, releases, experiments, health.
- **Languages**: ICU messages, bundled + remote + runtime translations, machine translation with any model (Claude, DeepL, LibreTranslate, your own).
- **Remote functions**: documents call code on the server or signed webhooks to your cloud.
- **UI from any backend**: sheets, alerts, toasts and redirects from `$actions` in your API responses, from messages over SSE / WebSocket / push, and from event-trigger rules the app evaluates. Standalone: `@zyrox/actions` for Node, a JSON Schema for every other language.
- **AI and agents**: an editor assistant, and an MCP server modeled on design-tool MCPs (design context, component map, tokens, scaffolding, validated edits), plus Agent Skills.
- **Headless**: versioned admin API with an OpenAPI spec, signed webhooks for publishes and releases, one-request screen fetching for server rendering, draft preview tokens for review builds, project export/import.
- **CLI**: upload manifests from CI, keep screens in git (`pull`/`push`/`validate`), export/import projects, preview tokens, offline snapshots, component scaffolding.

## Try it

```bash
pnpm install
pnpm --filter @zyrox/dashboard build
pnpm --filter @zyrox/server start          # http://localhost:4400 (sign up: the first user is the owner)
pnpm --filter @zyrox-examples/web dev       # http://localhost:5173: the example quick-commerce feed
```

Or with Docker: `docker build -t zyrox . && docker run -p 4400:4400 -v zyrox-data:/data zyrox` (see [self-hosting](docs/self-hosting.md) for Postgres).

The example apps run without a server (bundled documents, in-process example backend). Point them at your server with `VITE_ZYROX_ENDPOINT` / `VITE_ZYROX_KEY` (web) or `EXPO_PUBLIC_ZYROX_ENDPOINT` / `EXPO_PUBLIC_ZYROX_KEY` (Expo), after `pnpm --filter @zyrox-examples/components zyrox push --publish --release dev`.

## Docs

| Guide | For |
| --- | --- |
| [Library guide](docs/library.md) | Adding Zyrox to a React or React Native app: components, provider, screens, data, actions, state, languages, motion, analytics, caching, testing |
| [Self-hosting](docs/self-hosting.md) | Running the server and dashboard: Docker, Postgres, configuration, proxies and CDNs, scaling, backups, security, AI and translation |
| [Headless](docs/headless.md) | The HTTP API and OpenAPI spec, webhooks, server-side rendering, draft previews in real app builds, export and import |
| [UI from your backend](docs/backend-ui.md) | Sheets, alerts, toasts, redirects and event-trigger rules driven by any backend: `$actions` in responses, SSE / WebSocket / push messages, trigger rules |
| [Dynamic feed example](docs/dynamic-feed.md) | A Zepto / Blinkit / Amazon-style home feed: backend-ordered sections rendered by Zyrox, static and dynamic API calls |
| [Agent Skills](packages/skills/skills) | Guides for AI coding agents (also installable with `npx zyrox skills install`) |
| [Plan](PLAN.md) | Architecture, protocol and decisions |

## Repository

| Path | What |
| --- | --- |
| `packages/protocol` | Document, node, action and op types; Zod schemas; `defineComponent`; manifests |
| `packages/core` | Expressions, store, runtime, client (delivery, caching), i18n, validation (no React) |
| `packages/react` | Renderer for React DOM and React Native, provider, registry, preview tools |
| `packages/server` | Hono server: delivery API, admin API, publishing, releases, functions, preview relay, AI, MCP |
| `packages/actions` | `@zyrox/actions`: zero-dependency backend SDK for UI actions (builders, validation, SSE hub, push), plus the JSON Schema |
| `packages/cli` | `zyrox` command line |
| `packages/skills` | Agent Skills, component scaffolding, design-system rules |
| `apps/dashboard` | The dashboard (Vite + React) |
| `examples/*` | Example components (web + native), documents, web and Expo apps, an example shop backend |

Development: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm size`, and `pnpm --filter @zyrox/dashboard e2e`.
