---
name: zyrox-backend-ui
description: Drive a Zyrox app's UI from any backend (Node, Python, Go, Java, Ruby, PHP, serverless) - sheets, alerts, toasts, redirects, refreshes and allowed app actions sent as `$actions` in API responses, as messages over SSE / WebSocket / push notifications / polling / Firebase / Pusher, or as event-trigger rules the app evaluates on its own screen views and tracked events (in-app messaging). Covers @zyrox/actions (builders, UiChannel SSE hub, push data, validation, JSON Schema), the app side (overlays, ZyroxRemote, useZyroxActions, remoteActions allowlist) and security. Use when a backend should open a sheet, show a toast or alert, redirect, or react to app events.
---

# UI from your backend

The contract is JSON actions, the same built-ins documents use: `{ "do": "toast", "message": "Saved" }`. The Zyrox server is not involved; any backend can send them. Full guide: `docs/backend-ui.md` in the Zyrox repository.

## App setup (once)

```tsx
import { defaultOverlays } from '@zyrox/react/overlays';          // or { Sheet, Alert, Toasts, Message } of your design system
import { sseSource, ZyroxRemote } from '@zyrox/react/remote';

<ZyroxProvider overlays={defaultOverlays} fetcher={fetcher} navigate={navigate} /* remoteActions={[...DEFAULT_REMOTE_ACTIONS, 'addToCart']} */>
  <ZyroxRemote key={userId} sources={[sseSource(`${API}/ui/events`, { headers: async () => ({ authorization: `Bearer ${await token()}` }) })]}
               triggers="/ui/triggers" />
  <App />
</ZyroxProvider>
```

`overlays` alone is enough for `$actions` in responses. `<ZyroxRemote>` adds message sources and trigger rules.

## Actions

`navigate { to, params, presentation: push|replace|modal|sheet|reset }` (replace = redirect, reset = e.g. back to login), `back`, `openUrl { url }`,
`sheet { screen | document | content: { title, message, image, buttons }, params, title, size: auto|half|full, dismissible, id, onClose }`, `closeSheet { id?, result? }`,
`alert { title, message, buttons }`, `toast { message, tone: info|success|warning|danger, duration, action: { label, actions } }`,
`refresh { data? }`, `track { event, props }`, `setState`, `setErrors { form, errors }`, `resetForm`, `setLocale`, `if`.
Buttons: `{ label, style: default|primary|cancel|destructive, actions }`. App actions (`addToCart`…) only if the app lists them in `remoteActions`.

## 1. `$actions` in responses (user did something)

```ts
import { ui, withActions } from '@zyrox/actions';
res.json(withActions({ discount }, ui.toast('FIRST100 applied', { tone: 'success' })));
res.status(422).json(withActions({ error: 'invalid' }, ui.alert('Coupon not valid', 'It expired.')));
res.status(401).json(withActions({}, ui.reset('login')));          // session expired → sign-in
```
Other languages: `{"data": …, "$actions": [{"do": "toast", "message": "Saved"}]}`. Error bodies count too (the app's fetcher must throw `FetchError(message, status, body)` or an error with `status`/`body`). Not cached-replayed; avoid on auto-refreshing data sources.

## 2. Messages (server-side event)

`{ id?, actions?, triggers?, expiresAt? }`: `id` runs once per install (safe to resend); `expiresAt` drops late deliveries.

```ts
import { UiChannel, ui, uiMessage, toPushData } from '@zyrox/actions';
const channel = new UiChannel();
app.get('/ui/events', auth, (req, res) => channel.pipe(req.user.id, req, res));          // Express/node:http
export const GET = async (req: Request) => channel.sse((await auth(req)).userId, req);    // Hono/Next/Bun/Deno
channel.publish(userId, uiMessage([ui.message({ title: 'Order on the way 🛵' })], { id: `order-${id}-otw`, expiresIn: 600 }));
await fcm.send({ token, data: toPushData(uiMessage([ui.navigate('order', { id })], { id: `push-${id}` })) });
```
Multiple instances: fan out via Redis/NATS and `publish` on each. App side: `sseSource`, `webSocketSource`, `pollSource`, or any `(receive) => unsubscribe` (Pusher, Firestore, push notification listeners: `receive(notification.data)`).

## 3. Trigger rules (app event → UI, no round trip)

```ts
import { trigger, ui } from '@zyrox/actions';
app.get('/ui/triggers', auth, (req, res) => res.json({ triggers: [
  trigger({ id: 'free-delivery', on: 'track', name: 'add_to_cart', if: '{{ event.props.price < 199 }}', once: true,
            actions: [ui.message({ title: 'Free delivery over ₹199', message: 'Add ₹{{ 199 - event.props.price }} more.' })] }),
  trigger({ id: 'fruits', on: 'screen_view', name: 'shop-collection', if: "{{ event.params.id == 'fruits' }}", cooldown: 3600, delay: 1200,
            actions: [ui.toast('Mangoes are back 🥭')] }),
]}));
```
`on`: `screen_view` (name = screen key) | `track` (name = event) | `app_open` | `foreground`. `if` scope: `event` (`name`, `screen`, `params`, `props`), `app`, `device`. Limits: `once`, `cooldown` (s), `maxPerSession`, `delay` (ms, skipped if the user left), `startsAt`/`endsAt`. Trigger actions may use `{{ }}`; direct actions and messages are literal.

## Non-Zyrox screens

`const actions = useZyroxActions()`: `actions.handle(responseJson)` in your API client interceptor, `actions.screenView('cart', props)`, `actions.track('checkout', props)` (feed trigger rules), `actions.toast(…)`, `actions.sheet(…)`, `actions.run([...])` (trusted, any action).

## Rules

- Validate before sending: `assertUiActions(actions)`, `validateUiTriggers(rules)`; other languages: `@zyrox/actions/schema.json`.
- Default allowlist: navigation + UI built-ins + `track`/`setState`/`setLocale`/`setErrors`/`resetForm`/`if`; never `request`/`call`. One disallowed action rejects the whole list.
- Derive SSE channel keys from the authenticated session, never from client parameters. Keep push payloads < 4 KB (send a sheet `screen` key, not a document).
- Prefer `sheet { screen: '…' }` for rich content so designers edit it in the dashboard; use `content` for simple messages.
