---
name: zyrox-data
description: Connect Zyrox server-driven screens to data and APIs - document data sources (reactive URLs, conditions, debounce, polling, mocks), the app fetcher and auth, the request action, remote/cloud functions (call action, server code functions, signed webhooks to Lambda/Cloud Run/Firebase/Vercel), forms, search, pagination, optimistic updates and error states. Use when a Zyrox screen needs to load or send data, call a backend or cloud function, or integrate GraphQL/REST.
---

# Data and API integration

Zyrox serves **structure**; your APIs serve **data**. The app fetches with its own auth through the provider's `fetcher`, so documents never contain secrets (documents are public).

## Data sources (load)

```jsonc
"data": {
  "user":   { "url": "/me" },
  "orders": { "url": "/users/{{ data.user.id }}/orders", "if": "{{ data.user.id }}" },         // waits for user
  "search": { "url": "/search?q={{ state.q }}", "if": "{{ len(state.q) > 1 }}", "debounce": 300 },
  "live":   { "url": "/scores", "refresh": ["mount", "foreground", 15] },                      // poll every 15 s
  "feed":   { "kind": "graphql", "url": "/graphql", "method": "POST",
              "body": { "query": "{ feed { id title } }" }, "mock": { "feed": [] } }
}
```

- Results: `{{ data.key }}`; status: `{{ loading.key }}`; failures: `{{ error.key.message }}` / `.status`.
- A source refetches automatically when anything its `url`/`body`/`headers`/`if` reads changes (latest response wins).
- `refresh`: `mount` (default), `foreground` (app/tab returns), or seconds.
- `cache`: seconds to reuse a response for the same request, shared by every screen (e.g. `"cache": 300` for a catalog). Going back to or reopening a screen shows its data instantly; older responses still show at once while a fresh one loads. Memory only; clear it on sign-out with your own `dataCache={new DataCache()}` on the provider and `dataCache.clear()`. Don't cache per-user data unless your fetcher's auth is part of the request.
- Always give a realistic `mock`: the dashboard canvas and device preview use it.
- Refresh manually: `{ "do": "refresh", "data": "feed" }` (or all sources without `data`).

## The fetcher (your app)

```ts
const fetcher: Fetcher = async ({ url, method, headers, body, kind, key, source, signal }) => {
  const res = await fetch(url, { method, signal, headers: { ...headers, authorization: `Bearer ${await getToken()}`,
    'content-type': 'application/json' }, body: body == null || method === 'GET' ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new FetchError(json?.message ?? `HTTP ${res.status}`, res.status, json); // → error.<key> / onError
  return kind === 'graphql' ? json.data : json;
};
<ZyroxProvider fetcher={fetcher} apiBaseUrl="https://api.example.com" allowedOrigins={['https://cdn.example.com']} />
```

Relative URLs are joined to `apiBaseUrl`; absolute URLs must match `apiBaseUrl`'s origin or `allowedOrigins`.

## Sending data: the request action

```jsonc
{ "do": "request", "url": "/cart", "method": "POST", "body": { "id": "{{ item.id }}", "qty": "{{ state.qty }}" },
  "into": "cartResult",                                   // optional state path for the response
  "onSuccess": [{ "do": "refresh", "data": "cart" }, { "do": "track", "event": "add_to_cart" }],   // event = response
  "onError":   [{ "do": "setState", "path": "error", "value": "{{ event.message }}" }] }          // event = { message, status, body }
```

Without `onError`, a failure stops the action list and is reported as an `error` event.

## Remote / cloud functions: the call action

```jsonc
{ "do": "call", "fn": "applyCoupon", "args": { "code": "{{ state.code }}", "total": "{{ data.cart.total }}" },
  "into": "quote", "onSuccess": [ … ], "onError": [ … ] }
```

By default it goes to the Zyrox server (`POST /v1/functions/<name>`), which runs, in order:

1. **Code functions** in the server process:
```ts
createZyroxServer({ functions: { applyCoupon: async (args, ctx) => ({ total: Number(args.total) * 0.9 }) } });
// ctx: { project, environment, user, attrs, screen, nodeId }; throw FunctionError(message, status) for clean errors
```
2. **Webhook functions** (dashboard → Settings → Functions): the server POSTs `{ fn, args, context }` to your URL with
   `x-zyrox-timestamp` and `x-zyrox-signature: sha256=HMAC(secret, timestamp + "." + body)`. Verify it:
```ts
import { verifySignature } from '@zyrox/server';
if (!verifySignature(secret, req.headers['x-zyrox-timestamp'], rawBody, req.headers['x-zyrox-signature'])) return res.status(401).end();
res.json({ result: { total: 90 } });                       // or { error: { message } } with a 4xx/5xx
```
   Works with AWS Lambda URLs, Cloud Run, Firebase HTTPS functions, Vercel/Netlify functions.
3. Or route calls yourself: `<ZyroxProvider callFunction={(fn, args) => httpsCallable(functions, fn)(args).then((r) => r.data)} />`.

## Recipes

- **Search as you type:** `TextField` with `"bind": "q"`; source `"/search?q={{ state.q }}"` with `"if"` and `"debounce": 300`; show `{{ loading.search }}`.
- **Pagination:** list `on.endReached` → `{ "do": "request", "url": "/feed?cursor={{ state.cursor }}", "onSuccess": [{ "do": "setState", "path": "items", "value": "{{ concat(state.items, event.items) }}" }, { "do": "setState", "path": "cursor", "value": "{{ event.next }}" }] }`.
- **Optimistic update:** `setState` first, then `request` with `onError` that reverts.
- **Dependent data:** `"if": "{{ data.user.id }}"` on the second source.
- **Form submit:** `validate` the form (rules in `forms`, see zyrox-screens), set `submitting`, `request`, `onSuccess` navigate, `onError` → `setErrors` with `{{ event.body.errors ?? {} }}` (your API answers e.g. 422 `{ "errors": { "email": "Already registered" } }`) or show `{{ event.message }}`; clear `submitting` in both. Always re-validate on the server.
- **Live field checks** (username / pincode / coupon): a data source with `"if"` + `"debounce"` (`"/username-available?u={{ trim(state.form.username) }}"`) and a custom rule `{ "check": "{{ data.availability.username != value || data.availability.available }}", "message": "Taken" }`.
- **Data from the host app** (session, flags, cart count): pass `app={{ … }}` on the provider → `{{ app.cartCount }}`.
- **Backend-driven feed (Zepto / Blinkit / Amazon style):** the feed API returns typed sections (`{ type: 'banners' | 'categories' | 'rail' | 'zyrox', … }`). The feed document lists `{{ data.feed.sections }}` with one template that switches on `item.type` (`"if": "{{ item.type == 'rail' }}"`) and skips unknown types (`"if": "{{ includes([...], item.type) }}"`). Sections that load their own data are separate documents rendered by a `Section` component (`<ZyroxScreen screen={screen} params={params} />`), whose data source uses a dynamic URL from params (`"url": "{{ params.api }}"`, `"cache": 60`). Full walkthrough: `docs/dynamic-feed.md` in the Zyrox repository.
- **Derived values without lambdas:** `pluck`, `find(list, 'id', state.selected)`, `filterBy`, `sortBy`, `sum(list, 'price')`, `format.currency(…)`.

## Security

- Documents are public and cached by CDNs: no tokens, keys or personal data in documents.
- Only registered actions run; `openUrl` allows `https:`, `http:`, `mailto:`, `tel:` by default (`urlSchemes` to change).
