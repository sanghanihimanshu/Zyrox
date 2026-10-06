# UI from your backend: sheets, alerts, toasts, redirects and event triggers

Your backend can tell the app what to show: open a sheet, confirm with an alert, show a toast, redirect to another screen, refresh data, or run one of the app's own actions. It works with **any backend** (Node, Python, Go, Java, Ruby, PHP, serverless) and **any transport**; the Zyrox server is not involved. The contract is plain JSON; [`@wishyor/zyrox-actions`](../packages/actions) adds typed builders, validation, a server-sent events hub and push helpers for JavaScript backends, and a [JSON Schema](../packages/actions/ui-actions.schema.json) covers every other language.

There are three ways to send UI:

| | When | How |
| --- | --- | --- |
| **`$actions` in a response** | The user did something and your API answers | Add `$actions` to any JSON response (also error responses) |
| **Messages** | Something happened on the server (order shipped, payment failed, new offer) | Push a message over SSE, WebSocket, push notifications, polling, Firebase, Pusher… |
| **Trigger rules** | Something happens in the app (screen opened, item added) | Send rules once; the app evaluates them on its own events, instantly and offline |

```
 Your backend                                  The app (React / React Native)
 ────────────                                  ──────────────────────────────
 POST /coupons/apply → { ok, $actions: [toast] } ───────► runs toast
 order worker → channel.publish(user, message)  ─ SSE ──► runs sheet "Your order is on the way"
 GET /ui/triggers → [{ on: 'track', name: 'add_to_cart', if, actions }]
                                                  app emits add_to_cart → rule matches → sheet
```

- [Set up the app](#set-up-the-app)
- [Actions](#actions)
- [`$actions` in API responses](#actions-in-api-responses)
- [Messages: streams, push and polling](#messages-streams-push-and-polling)
- [Trigger rules](#trigger-rules)
- [Your own (non-Zyrox) screens](#your-own-non-zyrox-screens)
- [Your design system's overlays](#your-design-systems-overlays)
- [Security](#security)
- [Testing](#testing)

## Set up the app

```tsx
import { ZyroxProvider } from '@wishyor/zyrox-react';
import { defaultOverlays } from '@wishyor/zyrox-react/overlays';           // or your own components
import { sseSource, ZyroxRemote } from '@wishyor/zyrox-react/remote';

const uiEvents = sseSource('https://api.example.com/ui/events', {
  headers: async () => ({ authorization: `Bearer ${await getToken()}` }),
});

<ZyroxProvider
  registry={registry}
  fetcher={fetcher}
  navigate={navigate}
  overlays={defaultOverlays}                 // renders sheet, alert and toast
  remoteActions={undefined}                  // default: UI + navigation built-ins (see Security)
>
  <ZyroxRemote key={userId} sources={[uiEvents]} triggers="/ui/triggers" />
  <App />
</ZyroxProvider>
```

- `overlays` is all you need for `$actions` in responses and for documents that use `sheet`, `alert` and `toast`.
- `<ZyroxRemote>` (optional, a separate entry point so apps that don't use it don't ship it) connects message sources and loads trigger rules. `triggers` is a URL fetched with your `fetcher` (so it carries your auth), a list, or `() => Promise`. It reloads when the app returns to the foreground. Sources are read when it mounts: give it a `key` (e.g. the user id) to reconnect after sign-in.
- On React Native, `@wishyor/zyrox-react/overlays` resolves to native components: a `Modal` sheet with a spring, the platform's own `Alert.alert`, and toasts.

## Actions

Every action is `{ "do": "<name>", …arguments }`. They are the same built-ins documents use.

| Action | Arguments |
| --- | --- |
| `navigate` | `to` (document key or any route name your navigator maps), `params`, `presentation`: `push` (default), `replace` (a redirect), `modal`, `sheet`, `reset` (clear history, e.g. to sign-in), `transition` |
| `back` | `result` |
| `openUrl` | `url` (`https`, `http`, `mailto`, `tel` unless the app sets `urlSchemes`) |
| `sheet` | One of: `screen` (a document key, loaded like any screen), `document` (a whole document sent inline), `content` (`title`, `message`, `image`, `buttons`). Also `params`, `title`, `size` (`auto` `half` `full`), `dismissible` (default true), `id` (to close or replace it), `onClose` (actions; `event` = the close result) |
| `closeSheet` | `id` (default: the top sheet), `result` |
| `alert` | `title`, `message`, `buttons` (default one "OK"). The pressed button's `actions` run |
| `toast` | `message`, `tone` (`info` `success` `warning` `danger`), `duration` (ms, default 3000), `action` (`{ label, actions }`, e.g. Undo) |
| `refresh` | `data` (a data source of the current screen; empty: all) |
| `track` | `event`, `props`: goes to the app's analytics observers |
| `setState` | `path`, `value`: state of the screen that made the request |
| `setErrors` / `resetForm` | `form`, `errors` / `values`: field errors for a [document form](library.md#forms-and-validation) |
| `setLocale` | `locale` |
| `if` | `cond`, `then`, `else` |
| app actions | Whatever the app registered (`addToCart`, `logout`…), only if the app lists them in `remoteActions` |

Buttons are `{ "label", "style": "default" | "primary" | "cancel" | "destructive", "actions": [...] }`.

```json
[
  { "do": "toast", "message": "DIWALI30 applied: 30% off", "tone": "success" },
  { "do": "sheet", "id": "free-delivery", "content": {
      "title": "Free delivery over ₹199", "message": "Add ₹150 more to skip the fee.",
      "buttons": [
        { "label": "See bestsellers", "style": "primary", "actions": [{ "do": "navigate", "to": "shop-collection", "params": { "id": "bestsellers" } }] },
        { "label": "Keep shopping", "style": "cancel" }
      ] } },
  { "do": "alert", "title": "Cancel order?", "message": "You'll get a full refund.", "buttons": [
      { "label": "Keep it", "style": "cancel" },
      { "label": "Cancel order", "style": "destructive", "actions": [{ "do": "cancelOrder", "id": "o_123" }] } ] },
  { "do": "navigate", "to": "login", "presentation": "reset" }
]
```

A sheet can show a screen designed in the Zyrox dashboard (`"screen": "sheets/upgrade"`), so marketing can change its design while your backend decides when it appears.

## `$actions` in API responses

Add `$actions` to any JSON response the app fetches through its `fetcher`: document data sources, the `request` action, and `call` results from webhook functions. The app strips the key from the data and runs the actions. Error responses work the same way: the error's `body` is read when your fetcher throws a `FetchError(message, status, body)` or any error with `status` and `body`.

```ts
// Node / TypeScript with @wishyor/zyrox-actions
import { ui, withActions } from '@wishyor/zyrox-actions';

app.post('/coupons/apply', (req, res) => {
  const coupon = coupons.find(req.body.code);
  if (!coupon)
    return res.status(422).json(withActions({ error: 'invalid_coupon' },
      ui.alert('Coupon not valid', `${req.body.code} has expired.`)));
  res.json(withActions({ discount: coupon.discount }, ui.toast(`${coupon.code} applied`, { tone: 'success' })));
});

// Session expired, from any endpoint: send the user to sign-in.
res.status(401).json(withActions({ error: 'unauthorized' }, ui.reset('login')));
```

```python
# Python (FastAPI / Flask / Django): it's just JSON
return {"discount": 100, "$actions": [{"do": "toast", "message": "FIRST100 applied", "tone": "success"}]}
```

```go
// Go
json.NewEncoder(w).Encode(map[string]any{
  "order": order,
  "$actions": []map[string]any{{"do": "navigate", "to": "order", "params": map[string]any{"id": order.ID}, "presentation": "replace"}},
})
```

`$actions` run each time the response arrives. For data sources that refresh (foreground, polling), send one-off UI from endpoints the user triggers, or as a [message](#messages-streams-push-and-polling) with an `id`. Responses cached with a data source's `cache` keep their data but never re-run actions.

## Messages: streams, push and polling

A message is `{ id?, actions?, triggers?, expiresAt? }`:

- `id`: runs at most once per install (remembered for a week). Resending is safe, so retries and multiple transports don't show things twice.
- `expiresAt` (ISO date or epoch ms): ignored after that, e.g. a push notification delivered late.
- `triggers`: replaces the app's trigger rules.

The app also accepts a bare list of actions, a response with `$actions`, push data `{ "zyrox": "<json>" }`, and JSON text of any of these.

### Server-sent events

`UiChannel` from `@wishyor/zyrox-actions` is an in-process pub/sub with replay (`Last-Event-ID`) and keep-alives:

```ts
import { UiChannel, ui, uiMessage } from '@wishyor/zyrox-actions';

export const uiChannel = new UiChannel();

// Express / Fastify (reply.raw) / node:http
app.get('/ui/events', requireAuth, (req, res) => uiChannel.pipe(req.user.id, req, res));

// Hono, Next.js route handlers, Bun, Deno, Cloudflare Workers (web-standard Request/Response)
export const GET = async (req: Request) => uiChannel.sse((await auth(req)).userId, req);

// Anywhere in your backend: an order worker, a webhook from your payment provider…
uiChannel.publish(order.userId, uiMessage(
  [ui.message({ title: 'Your order is on the way 🛵', buttons: [ui.button('Track', [ui.navigate('order', { id: order.id })], 'primary')] })],
  { id: `order-${order.id}-out-for-delivery`, expiresIn: 600 },
));
uiChannel.broadcast([ui.toast('Checkout is back to normal', { tone: 'success' })]);
```

With several server instances, publish through Redis (or NATS, Postgres `LISTEN`) and call `uiChannel.publish` on every instance:

```ts
sub.subscribe('ui', (raw) => { const { user, message } = JSON.parse(raw); uiChannel.publish(user, message); });
// elsewhere: pub.publish('ui', JSON.stringify({ user, message }))
```

In other languages, write `text/event-stream` yourself: `data: {"actions":[…]}\n\n` per message, an `id:` line if you support replay, and a comment line (`: ping`) every 25 s. The app's `sseSource` runs over `XMLHttpRequest`, so it works on React Native and can send auth headers; it reconnects with backoff and `Last-Event-ID`.

### WebSocket, polling and anything else

```ts
import { pollSource, webSocketSource, type UiActionSource } from '@wishyor/zyrox-react/remote';

webSocketSource('wss://api.example.com/ui', { onOpen: (ws) => ws.send(JSON.stringify({ token })) });
pollSource(() => api.get('/ui/inbox'), { interval: 60 });

// Any transport is a function: call receive(message), return a disconnect function.
const pusher: UiActionSource = (receive) => {
  const channel = pusherClient.subscribe(`private-user-${userId}`);
  channel.bind('ui', receive);
  return () => pusherClient.unsubscribe(`private-user-${userId}`);
};
const firestore: UiActionSource = (receive) =>
  onSnapshot(query(collection(db, 'users', userId, 'ui'), where('createdAt', '>', since)), (snap) =>
    snap.docChanges().forEach((c) => c.type === 'added' && receive({ id: c.doc.id, ...c.doc.data() })));
```

### Push notifications

Data payloads carry a message; the app runs it when the notification arrives or is opened.

```ts
// Backend: FCM data values must be strings (≈4 KB in total). toPushData checks the size.
import { toPushData, ui, uiMessage } from '@wishyor/zyrox-actions';
await messaging.send({ token, notification: { title: 'Order shipped' },
  data: toPushData(uiMessage([ui.navigate('order', { id })], { id: `push-${id}`, expiresIn: 3600 })) });
```

```ts
// App (Expo): a source fed by expo-notifications
import * as Notifications from 'expo-notifications';
const push: UiActionSource = (receive) => {
  void Notifications.getLastNotificationResponseAsync().then((r) => r && receive(r.notification.request.content.data));
  const sub = Notifications.addNotificationResponseReceivedListener((r) => receive(r.notification.request.content.data));
  return () => sub.remove();
};
// React Native Firebase: messaging().onNotificationOpenedApp((m) => receive(m.data)), getInitialNotification()…
```

Keep push payloads small: send a sheet with a `screen` key rather than a whole document.

## Trigger rules

Rules let your backend decide what appears when something happens in the app, without a round trip and without an app release, like in-app messaging tools. The app evaluates them on its own events.

```ts
import { trigger, ui } from '@wishyor/zyrox-actions';

app.get('/ui/triggers', requireAuth, (req, res) => res.json({ triggers: [
  trigger({
    id: 'free-delivery',                       // limits count per id
    on: 'track', name: 'add_to_cart',          // the document's { do: 'track', event: 'add_to_cart' }
    if: '{{ event.props.price < 199 }}',
    once: true,
    actions: [ui.message({ title: 'Free delivery over ₹199',
      message: 'Add ₹{{ 199 - event.props.price }} more to skip the fee.' })],
  }),
  trigger({ id: 'mango-season', on: 'screen_view', name: 'shop-collection',
    if: "{{ event.params.id == 'fruits' }}", cooldown: 3600, delay: 1200,
    actions: [ui.toast('Mangoes are back 🥭', { action: { label: 'Show', actions: [ui.navigate('shop-product', { id: 'mango' })] } })] }),
  trigger({ id: 'plan-expiring', on: 'app_open', if: "{{ app.user.plan == 'trial' }}", maxPerSession: 1,
    actions: [ui.sheet({ screen: 'sheets/upgrade' })] }),
]}));
```

| Field | Meaning |
| --- | --- |
| `id` | Stable id; `once`, `cooldown` and `maxPerSession` count per id (stored on the device) |
| `on` | `screen_view` (`name` = screen key), `track` (`name` = event name), `app_open` (first load of the rules in a session), `foreground` |
| `name`, `screen` | Match the event name; only while this screen is shown |
| `if` | Expression with `event` (`name`, `screen`, `params`, `props`), `app` (the provider's `app`, e.g. user, plan, cart) and `device` |
| `once`, `cooldown` (s), `maxPerSession` | Frequency limits |
| `delay` (ms) | Wait first; skipped if the user left the screen meanwhile |
| `startsAt`, `endsAt` | Active window |
| `actions` | Run with expressions on, so text can use `{{ event.props.total }}` |

Events come from Zyrox screens (`screen_view` on mount, every `track` action) and from your own screens through [`useZyroxActions`](#your-own-non-zyrox-screens). Per-user rules are fine: personalize them on the server, it's your endpoint.

## Your own (non-Zyrox) screens

`useZyroxActions()` works anywhere under the provider:

```tsx
const actions = useZyroxActions();

// Your API client: run $actions from every response, not only Zyrox requests.
api.interceptors.response.use(
  (res) => { void actions.handle(res.data); return res; },
  (err) => { if (err.response?.data) void actions.handle(err.response.data); throw err; },
);

actions.screenView('cart', { total });           // trigger rules and analytics see your screens
actions.track('checkout', { total });
actions.toast('Saved', { tone: 'success' });
actions.sheet({ screen: 'sheets/address', params: { mode: 'edit' } });
await actions.run([{ do: 'alert', title: 'Delete address?', buttons: [/* … */] }]);  // trusted: any action
```

`handle` applies the same rules as backend messages (allowed actions only, text taken literally); with `<ZyroxRemote>` mounted, it also de-duplicates by message `id` and accepts trigger rules.

## Your design system's overlays

`defaultOverlays` is plain and accessible (dialog roles, focus, Escape, dark mode). `createOverlays({ light, dark })` adjusts colors, radius and font. To use your own components, pass `{ Sheet, Alert, Toasts, Message }`:

```tsx
import type { OverlayComponents } from '@wishyor/zyrox-react';

const overlays: OverlayComponents = {
  // children: the sheet's Zyrox screen or message; onDismiss: user closed it
  Sheet: ({ title, size, dismissible, onDismiss, children }) => (
    <BottomSheet title={title} snapPoints={size === 'half' ? ['50%'] : ['90%']}
      enablePanDownToClose={dismissible} onClose={onDismiss}>{children}</BottomSheet>),
  Alert: ({ title, message, buttons, onPress, onDismiss }) => (/* your dialog */),
  Toasts: ({ toasts, onPress, onDismiss }) => (/* toasts: { key, message, tone, action } */),
  Message: ({ title, message, image, buttons, onPress }) => (/* sheet content without a document */),
};
```

Mix and match: `{ ...defaultOverlays, Sheet: MySheet }`.

## Security

- **Allowed actions.** Backend actions are limited to `remoteActions`, by default UI and navigation built-ins: `navigate`, `back`, `openUrl`, `sheet`, `closeSheet`, `alert`, `toast`, `refresh`, `track`, `setState`, `setLocale`, `setErrors`, `resetForm`, `if`. `request` and `call` are excluded so messages can't make the app send data. A list containing anything else (including nested button actions) is rejected as a whole and reported as an error event. Allow app actions by name: `remoteActions={[...DEFAULT_REMOTE_ACTIONS, 'addToCart']}` (`DEFAULT_REMOTE_ACTIONS` from `@wishyor/zyrox-react`).
- **Text is literal.** Actions in responses and messages are not evaluated, so user content like a product name containing `{{ }}` is shown as is. Only trigger rules (which you author, like documents) use expressions.
- **`openUrl`** only opens the app's `urlSchemes`; **`navigate`** goes through your navigator, which decides what each name means.
- **Streams**: authenticate the connection and derive the channel key from the session, never from a query parameter the client chose. The example's `?user=demo` is for the demo only.
- **Push**: anyone who can send to your FCM/APNs project can send messages; keep those credentials on the server, and set `expiresAt` so stale messages don't run.

## Testing

```ts
import { assertUiActions, validateUiMessage, validateUiTriggers, uiJsonSchema } from '@wishyor/zyrox-actions';

assertUiActions(response.$actions);                         // throws with every problem listed
expect(validateUiTriggers(rules)).toEqual([]);
```

Other languages validate against [`ui-actions.schema.json`](../packages/actions/ui-actions.schema.json) (JSON Schema 2020-12; also exported as `@wishyor/zyrox-actions/schema.json`).

In the app, `ScreenRuntime.runRemote(actions)` and `UiActionCenter` from `@wishyor/zyrox-core` run without React; the example apps' parity tests drive the same rules on web and native (`examples/components/test/scenarios.ts`, scenario "backend-driven UI").

## The example

The [example shop backend](../examples/shop-api) does all of this: `POST /coupons/apply` answers with a toast or an alert, `GET /ui/triggers` serves the rules above, and `GET /ui/events` streams order updates (`curl -X POST 'localhost:4600/ui/demo/order?user=demo'`). The web and Expo apps show it: add a cheap item to the cart, open Fruits, apply the festive coupon, place an order from the cart.
