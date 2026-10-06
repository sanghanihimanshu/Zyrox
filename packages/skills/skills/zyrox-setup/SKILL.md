---
name: zyrox-setup
description: Set up Zyrox server-driven UI in a React (web) or React Native / Expo app - ZyroxProvider, registry, navigation, storage, offline snapshot, analytics/logging observers, motion adapters, dashboard preview route and live device preview. Use when adding Zyrox to an app, wiring navigation or analytics into Zyrox screens, or debugging why a server-driven screen doesn't load.
---

# Setting up Zyrox in an app

Zyrox renders JSON documents with **your own components**. The app needs: a registry (what it can render), a provider (how it talks to your app and the server), and screens.

## 1. Install

```bash
npm i @wishyor/zyrox-react          # web and React Native (same package)
npm i -D @wishyor/zyrox-cli         # manifest upload, snapshots, GitOps
```

## 2. Registry

```ts
// src/zyrox/registry.ts
import { createRegistry } from '@wishyor/zyrox-react';
import { Button, ProductCard } from './components';      // implement(...) results
import { addToCart } from './actions';                   // implementAction(...) results

export const registry = createRegistry({
  components: [Button, ProductCard],
  actions: [addToCart],
  helpers: { t: i18n.t },          // optional expression helpers (override built-ins)
  observers: [analyticsObserver],  // optional, see below
  motion: framerMotion,            // optional motion adapter
  transitions: ['slide', 'fade'],  // names your navigator understands
  tokens: { color: { primary: '#4f46e5' }, space: { sm: 8, md: 16 } },
  plugins: [],                     // packaged bundles of the above
});
```

Keep the same definitions list in `zyrox.config.ts` so the CLI uploads the same manifest (see the zyrox-components skill). `registry.manifest.hash` must equal what `zyrox manifest build` prints.

## 3. Provider and screens

```tsx
<ZyroxProvider
  registry={registry}
  endpoint="https://ui.example.com"      // Zyrox server; omit to render inline documents
  publicKey={ENV === 'prod' ? 'pk_prod_…' : 'pk_dev_…'}
  appVersion="3.4.1"                     // used by release rules: semver(client.app, '>=3.4')
  user={userIdOrInstallId}               // sticky rollouts/experiments; generated if omitted
  attrs={{ country: 'IN', plan: 'pro' }} // targeting attributes
  storage={storage}                      // { getItem, setItem, removeItem } sync or async
  snapshot={require('./zyrox.snapshot.json')} // first launch offline
  fetcher={authedFetch}                  // data sources + request action, with YOUR auth
  apiBaseUrl="https://api.example.com"
  navigate={(to, params, { presentation, transition }) => …}
  back={(result) => …}
  observers={[…]}
  app={{ user, flags }}                  // readable in documents as {{ app.user.name }}
  strings={bundledTranslations} defaultLocale="en"
>
  <ZyroxScreen screen="home" params={{}} loading={<Skeleton />} fallback={<NativeHome />} />
</ZyroxProvider>
```

- `<ZyroxScreen document={doc} />` renders an inline document (tests, SSR, bundled screens).
- A mounted screen keeps the version it opened with; pass `live` to switch immediately.
- Screens can be embedded anywhere (a section inside a native screen, a tab, a modal).

### Storage

Web defaults to `localStorage`. React Native has no default; pass one:

```ts
const storage = { getItem: (k) => mmkv.getString(k), setItem: (k, v) => mmkv.set(k, v), removeItem: (k) => mmkv.delete(k) };
// or AsyncStorage directly: storage={AsyncStorage}
```

### Navigation adapters

`navigate(to, params, { presentation, transition })` - `presentation` is `push | replace | modal | sheet | reset`.

```ts
// Expo Router: app/screen/[key].tsx renders <ZyroxScreen screen={key} params={params} />
navigate={(to, params, { presentation }) =>
  presentation === 'replace' ? router.replace({ pathname: '/screen/[key]', params: { key: to, ...params } })
  : router.push({ pathname: presentation === 'modal' ? '/modal/[key]' : '/screen/[key]', params: { key: to, ...params } })}
// React Navigation
navigate={(to, params, o) => (o.presentation === 'replace' ? navigation.replace : navigation.navigate)('Zyrox', { screen: to, params })}
// React Router / Next.js
navigate={(to, params) => navigateFn(`/s/${to}?${new URLSearchParams(params as Record<string, string>)}`)}
```

Map `to` to existing native screens too (e.g. `to === 'checkout'` → your native checkout).

## 4. Analytics, logging, error tracking (observers)

Every runtime event goes to each observer: `screen_view`, `screen_load` (durationMs, source), `data_load`, `action` (durationMs, ok), `track`, `exposure` (experiment, variant), `error` (kind: expression | action | data | render | unknown_component | document), `log`. Each has `screen`, `version`, `nodeId`, `meta`.

```ts
const segment: Observer = (e) => {
  if (e.type === 'track') analytics.track(e.name, { ...e.props, screen: e.screen });
  if (e.type === 'screen_view') analytics.screen(e.screen, { version: e.version });
  if (e.type === 'exposure') analytics.track('Experiment Viewed', { experiment: e.experiment, variant: e.variant });
};
const sentry: Observer = (e) => {
  if (e.type === 'error') Sentry.captureMessage(`[zyrox:${e.kind}] ${e.message}`, { extra: e });
};
const perf: Observer = (e) => {
  if (e.type === 'screen_load' || e.type === 'data_load') datadogRum.addTiming(`zyrox.${e.type}`, e.durationMs);
};
```

`debug` on the provider logs every event and checks props against schemas.

## 5. Motion (animations)

Zyrox never animates; documents carry `motion: { enter, exit, layout }` presets and your adapter maps them.

```tsx
// Web: Framer Motion
const framerMotion: MotionAdapter = {
  presets: ['fade', 'slideUp'],
  Group: AnimatePresence,
  Item: ({ motion: m, visible, children }) => (
    <AnimatePresence>{visible ? <motion.div initial={…} animate={…} exit={…} layout={Boolean(m.layout)}>{children}</motion.div> : null}</AnimatePresence>
  ),
};
// React Native: Reanimated
const reanimated: MotionAdapter = {
  presets: ['fade', 'slideUp'],
  Item: ({ motion: m, visible, children }) =>
    visible ? <Animated.View entering={m.enter === 'slideUp' ? SlideInDown : FadeIn} exiting={FadeOut} layout={m.layout ? LinearTransition : undefined}>{children}</Animated.View> : null,
};
```

## 6. Dashboard preview and live device preview

- **Canvas with your real components (web):** add a route that renders `<ZyroxPreviewHost />` inside your provider (e.g. `/__zyrox/preview`), then set it as the project's Preview URL in Settings.
- **Live preview on devices:** the editor's "Device" button shows a QR code with `yourscheme://zyrox-preview?server=…&session=…&token=…`. Handle it:

```tsx
import { parsePreviewLink, ZyroxLivePreview } from '@wishyor/zyrox-react/preview';
const link = parsePreviewLink(url);               // from Linking (RN) or location.href (web)
if (link) return <ZyroxLivePreview {...link} onClose={…} />;   // inside ZyroxProvider
```

## 7. CI

```bash
npx zyrox manifest push --label "$APP_VERSION"     # every app build
npx zyrox snapshot --public-key "$ZYROX_PROD_KEY" --out src/zyrox.snapshot.json   # before bundling
```

## 8. AI agents (Claude Code, Cursor…)

```bash
npx zyrox skills install            # these guides → .claude/skills
npx zyrox skills rules --out .claude/rules/zyrox-design-system.md   # your components and tokens
npx zyrox mcp                       # prints the MCP setup for your server
```

The MCP server (`<server>/mcp`, bearer = personal access token) gives agents design context, component maps, tokens, scaffolding, ops editing, validation and live device previews.

## Troubleshooting

- Screen shows `fallback`: no release for that key in this environment, wrong public key, or protocol mismatch.
- Component renders nothing: not in the registry (an `unknown_component` error event) - add it or give the node a `fallback`.
- Data never loads: check the `data_load` / `error` events, `apiBaseUrl` and `allowedOrigins` (absolute URLs must match an allowed origin).
- Nothing updates after publishing: releases reach apps on the next bootstrap (environment TTL, default 60 s, and on app foreground).
