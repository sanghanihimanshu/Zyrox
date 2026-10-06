---
name: zyrox-performance
description: Make Zyrox server-driven screens fast and reliable in production mobile and web apps - how the caching layers work (immutable documents, ETag bootstrap, offline snapshot, previous-version fallback, data source cache), fast startup with synchronous storage, prefetching, retries and timeouts on flaky networks, list virtualization, images, CDN and server deployment. Use when tuning load time, preparing a release, debugging slow or flickering screens, or setting up Zyrox for production.
---

# Performance and production

## How a screen loads

1. **Bootstrap** (`/v1/bootstrap`, one small JSON per user): which version of each screen and translation bundle this user gets. Cached on the device for its TTL (environment setting, default 60 s), then revalidated with an ETag: unchanged → `304`, no body.
2. **Documents** (`/v1/docs/<ref>`): content-addressed and immutable (`cache-control: immutable`, one year). Downloaded once, kept in storage, served by any CDN, precompressed (Brotli/gzip) by the server.
3. **Render**: expressions are parsed once per document; each node subscribes only to the state paths it reads, so typing in a field re-renders that field, not the screen.

What the client does for you:

| Situation | Behaviour |
| --- | --- |
| Cold start, nothing cached | Snapshot (if bundled) renders instantly; the network updates it in the background |
| Warm start with sync storage (MMKV, localStorage) | Cached screens render on the first frame (no loading state) |
| New version released | Downloaded in the background; the previous version stays on screen until it's ready (`stale: true`) |
| Download fails / offline | Previous version keeps showing; retried after 10 s, on foreground, and on the next bootstrap |
| Flaky network | 15 s timeout per request, 2 retries with exponential backoff and jitter on network errors, 5xx and 429 |
| After each bootstrap | Up to 4 documents downloaded in parallel; versions no longer released are deleted from storage |
| Background | Telemetry flushed (and kept for the next try when offline) |

## Production checklist (mobile)

- **Storage: use MMKV** on React Native (synchronous → first-frame render). AsyncStorage works but shows a loading frame on cold start.
  ```ts
  const mmkv = new MMKV({ id: 'zyrox' });
  const storage = { getItem: (k) => mmkv.getString(k), setItem: (k, v) => mmkv.set(k, v), removeItem: (k) => mmkv.delete(k) };
  ```
- **Bundle a snapshot** so the very first launch works offline and without a spinner: `npx zyrox snapshot --public-key "$ZYROX_PROD_KEY" --out src/zyrox.snapshot.json` in CI before building, then `snapshot={require('./zyrox.snapshot.json')}`.
- **Prefetch policy**: default `'all'` (best offline). With many screens, prefetch only the ones users open first: create the client yourself with `prefetch: ['home', 'cart']` (others load on demand) and pass `client={client}`.
- **Placeholders**: give `<ZyroxScreen loading={<Skeleton />} fallback={<NativeScreen />}>`; `fallback` also covers screens not released yet.
- **Lists**: implement list components with `FlatList`/`FlashList` and pass `templates.item` as `renderItem`; never render hundreds of children with `repeat`.
- **Images**: implement your image component with a caching library (`expo-image`, FastImage) and give it fixed dimensions or an aspect ratio to avoid layout shifts.
- **Data**: add `"cache": <seconds>` to data sources that rarely change (catalogs, config) for instant back navigation; keep the `mock` realistic for previews.
- **Animations**: map motion presets to Reanimated (UI thread) in your motion adapter.
- **TTL**: 60 s is a good default; raise it for apps with huge traffic, lower it while iterating.
- **Hermes** (default in Expo) and release builds: measure there, not in dev mode.

## Server and CDN

- Run with Postgres (`DATABASE_URL=postgres://…`) for production; PGlite is for local/small installs.
- Put a CDN in front of `/v1/docs/*` and `/v1/strings/*` (immutable, safe to cache for a year). Never cache `/v1/bootstrap` at a shared layer (it's per user: `cache-control: private, no-cache`).
- The bootstrap is computed from an in-memory snapshot per environment (refreshed every few seconds and on every release), so it scales horizontally; live preview sessions need sticky sessions or a single instance.
- Set `ZYROX_PUBLIC_URL` when behind a proxy so preview links point to the right host.
- Watch Health in the dashboard: views, error rate per version, function failures and app-build adoption come from client telemetry.

## Measuring

- `observers` receive `screen_view`, `data_load` (`durationMs`, `cached`), `action` and `error` events: forward them to your APM to track time-to-data per screen.
- `client.getDocument(key).source` tells whether a screen came from `snapshot`, `cache` or `network`.
- The app-facing runtime imports are about 30 KB gzipped before React; `pnpm size` guards a 35 KB budget.
