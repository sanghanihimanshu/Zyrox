# @zyrox/actions

Drive a Zyrox app's UI from your backend: sheets, alerts, toasts, redirects and event-trigger rules. Zero dependencies; runs on Node, Bun, Deno and edge runtimes. Not a JavaScript backend? Send the same JSON and validate it against [`ui-actions.schema.json`](ui-actions.schema.json).

```ts
import { trigger, toPushData, ui, UiChannel, uiMessage, withActions } from '@zyrox/actions';

// 1. In an API response
res.json(withActions({ discount: 100 }, ui.toast('FIRST100 applied', { tone: 'success' })));
res.status(401).json(withActions({}, ui.reset('login')));

// 2. Pushed: server-sent events (Express: pipe; Hono / Next.js / Bun / Deno: sse)
const channel = new UiChannel();
app.get('/ui/events', auth, (req, res) => channel.pipe(req.user.id, req, res));
channel.publish(userId, uiMessage([ui.message({ title: 'Your order is on the way' })], { id: 'o1-otw', expiresIn: 600 }));
await fcm.send({ token, data: toPushData(uiMessage([ui.navigate('order', { id: 'o1' })], { id: 'push-o1' })) });

// 3. Rules the app evaluates on its own events
res.json({ triggers: [trigger({ id: 'big-cart', on: 'track', name: 'add_to_cart', if: '{{ event.props.price < 199 }}', once: true, actions: [ui.toast('Free delivery over ₹199')] })] });
```

| Export | |
| --- | --- |
| `ui` | `navigate`, `redirect`, `reset`, `back`, `openUrl`, `sheet`, `message`, `closeSheet`, `alert`, `confirm`, `toast`, `button`, `refresh`, `track`, `setState`, `setErrors`, `action` |
| `withActions(body, ...actions)` | `{ ...body, $actions }` |
| `uiMessage(actions, { id, expiresIn, expiresAt, triggers })` | A message for streams, push and polling |
| `trigger(rule)` | A typed trigger rule |
| `UiChannel` | In-process pub/sub by key with SSE (`sse(key, request)`, `pipe(key, req, res)`), replay and keep-alive |
| `encodeSse`, `SSE_HEADERS` | For your own SSE endpoints |
| `toPushData(message)` | `{ zyrox: "<json>" }` within push size limits |
| `validateUiActions`, `validateUiMessage`, `validateUiTriggers`, `assertUiActions` | Problems with paths |
| `uiJsonSchema` / `@zyrox/actions/schema.json` | JSON Schema 2020-12 |

The app side (`overlays`, `<ZyroxRemote>`, `useZyroxActions`) and the security model are described in [UI from your backend](../../docs/backend-ui.md).
