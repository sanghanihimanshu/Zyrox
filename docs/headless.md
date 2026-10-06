# Headless: webhooks, API, server rendering, draft previews, export

Everything the dashboard does goes through a documented HTTP API, so Zyrox fits into the rest of your stack: your CI hears about releases, your website renders screens on the server, reviewers see drafts in real app builds, and content moves between servers as a file. This guide covers React and React Native apps and the server; it assumes the [self-hosting guide](self-hosting.md) setup.

- [The API](#the-api)
- [Webhooks](#webhooks)
- [Server-side rendering](#server-side-rendering)
- [Draft previews](#draft-previews)
- [Export and import](#export-and-import)

## The API

| | Base path | Auth |
| --- | --- | --- |
| Delivery (apps, SSR) | `/v1` | `Authorization: Bearer pk_…` (an environment's public key; CORS open) |
| Admin (dashboard, CLI, CI, agents, your tools) | `/api/v1` | `Authorization: Bearer zyx_…` (personal access token) or the dashboard session cookie |
| MCP (AI agents) | `/mcp` | Personal access token |

- **OpenAPI 3.1:** `GET /api/v1/openapi.json` describes every endpoint (a test keeps it in sync with the server's routes). Generate a client with your tool of choice (`openapi-typescript`, `openapi-generator`, Postman, Insomnia…).
- **Versioning:** `/api/v1` is the stable path for integrations. `/api` is the same API, kept for the dashboard. Breaking changes would come as `/api/v2`.
- **Tokens:** create them under Settings → Access tokens or `POST /api/v1/tokens`. Scope a token to one project, a maximum role and an expiry for CI (`{ "name": "ci", "project": "shop", "role": "publisher", "expiresInDays": 90 }`).
- **Browsers:** to call the admin API from your own admin UI on another origin, list it in `ZYROX_CORS_ORIGINS` and use a token (cookies are never sent cross-origin).
- **Errors:** `{ "error": { "message", "code", "details" } }` with the HTTP status. Rate-limited requests get `429` with `retry-after`.

```bash
curl -H "authorization: Bearer $ZYROX_TOKEN" https://ui.example.com/api/v1/projects/shop/documents
curl -X POST -H "authorization: Bearer $ZYROX_TOKEN" -H 'content-type: application/json' \
  -d '{"message":"Diwali banner","release":["prod"]}' \
  https://ui.example.com/api/v1/projects/shop/documents/home/publish
```

## Webhooks

Settings → Webhooks (or `POST /api/v1/projects/:project/webhooks`) sends project events to your URLs: rebuild a static site when a screen is published, purge a CDN, post to a team channel, sync a CMS, or alert on rollbacks.

```bash
curl -X POST -H "authorization: Bearer $ZYROX_TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://ci.example.com/hooks/zyrox","events":["document.publish","release.*"]}' \
  https://ui.example.com/api/v1/projects/shop/webhooks
# → { "webhook": { "id": "whk_…", "secret": "whsec_…" } }   (the secret is shown once)
```

**Events** are the audit log's actions: `document.create`, `document.publish`, `document.restore`, `document.archive`, `release.set`, `release.rollback`, `release.promote`, `release.remove`, `experiment.create`, `experiment.update`, `function.*`, `webhook.*`, `manifest.upload`, `member.*`, `project.update`, `project.import`, `environment.update`, `translate`, `ai.edit`, `preview_token.create`. Subscribe to names, prefixes (`release.*`) or `*`.

**Payload** (`POST`, JSON):

```json
{
  "id": "evt_8f3k2m9q4t7v1x5z",
  "event": "document.publish",
  "project": { "id": "prj_…", "slug": "shop" },
  "actor": { "id": "usr_…", "email": "ada@example.com" },
  "target": "home",
  "details": { "number": 12, "ref": "d_3f…", "release": ["prod"] },
  "createdAt": "2026-10-06T09:30:00.000Z"
}
```

Headers: `x-zyrox-event`, `x-zyrox-delivery` (the event id, the same on every retry: ignore ids you've seen), `x-zyrox-timestamp` and `x-zyrox-signature: sha256=HMAC(secret, timestamp + "." + body)`. Verify it like a webhook function:

```ts
import { verifySignature } from '@wishyor/zyrox-server';

app.post('/hooks/zyrox', express.raw({ type: 'application/json' }), (req, res) => {
  const body = req.body.toString('utf8');
  if (!verifySignature(process.env.ZYROX_WEBHOOK_SECRET!, req.get('x-zyrox-timestamp')!, body, req.get('x-zyrox-signature')!))
    return res.sendStatus(401);
  const event = JSON.parse(body);
  if (event.event === 'document.publish') triggerSiteRebuild(event.target);
  res.sendStatus(204);
});
```

```python
import hmac, hashlib, time
def verify(secret: str, timestamp: str, body: bytes, signature: str) -> bool:
    if abs(time.time() - int(timestamp)) > 300: return False
    expected = "sha256=" + hmac.new(secret.encode(), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
```

**Delivery:** in the background, with a 10 s timeout. Any `2xx` acknowledges; anything else (or no answer) is retried after 10 s, 1 min and 5 min. Each attempt is logged (Settings → Webhooks → Log, or `GET …/webhooks/:id/deliveries`; the last 100 per webhook). "Send test" posts a signed `ping`. Disable a webhook to pause it, rotate its secret from the same screen. Like functions, webhook URLs must be `https://` and can't reach private networks (unless `ZYROX_ALLOW_PRIVATE_URLS` for development).

## Server-side rendering

`GET /v1/screens/:key` returns one screen exactly as a given user would get it (releases, targeting, rollouts, experiments), in one request. `fetchScreen` from `@wishyor/zyrox-core` wraps it, so server code needs no React:

```tsx
// app/[[...slug]]/page.tsx (Next.js App Router, a server component)
import { fetchScreen } from '@wishyor/zyrox-core';
import { cookies, draftMode, headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { Screen } from './screen';   // a client component: <ZyroxProvider …><ZyroxScreen document={…} version={…} /></ZyroxProvider>

export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const key = (await params).slug?.join('/') ?? 'home';
  const screen = await fetchScreen({
    endpoint: process.env.ZYROX_ENDPOINT!,
    publicKey: process.env.ZYROX_KEY!,
    screen: key,
    user: (await cookies()).get('uid')?.value,          // same id the app uses, for rollouts
    locale: (await headers()).get('accept-language') ?? undefined,
    manifestHash: MANIFEST_HASH,                         // your registry's manifest.hash (from zyrox manifest build)
    previewToken: (await draftMode()).isEnabled ? process.env.ZYROX_PREVIEW_TOKEN : undefined,
  });
  if (!screen) notFound();
  return <Screen document={screen.document} version={screen.ref} />;
}
```

```ts
// Remix / React Router loader
export async function loader({ request, params }: LoaderFunctionArgs) {
  const screen = await fetchScreen({ endpoint, publicKey, screen: params.key!, locale: request.headers.get('accept-language') ?? undefined });
  if (!screen) throw new Response('Not found', { status: 404 });
  return screen;
}
```

- The response carries `ref` (pass it as `version` so events are attributed) and, when the user is in an experiment, `experiment: { key, variant }`.
- Responses are `private, no-cache` with an `ETag`: per user, but cheap to revalidate. For pages without per-user targeting, cache the result in your framework (`fetch` caching, `unstable_cache`) and revalidate from a `document.publish` / `release.*` webhook.
- Data sources still run in the browser with your fetcher. To render data on the server too, fetch it in your loader and pass it through `app` or initial params.
- On the client, keep the provider without `endpoint` for a pure SSR page, or with it to pick up newer releases after hydration (`live`).

## Draft previews

A preview token makes the server answer with **drafts instead of releases** for one project: in real app builds (QA, stakeholder review on devices, TestFlight / internal tracks) and in SSR "draft mode". It complements the dashboard's live device preview, which follows one document while someone edits it.

Create one under Settings → Previews & export, with `zyrox preview-token --minutes 1440 [--documents home,offers]`, or `POST /api/v1/projects/:project/preview-tokens` (editor role; `{ "expiresInMinutes": 60, "documents": ["home"] }`). Then:

```tsx
// A review build of your app
<ZyroxProvider endpoint={…} publicKey={…} previewToken={process.env.EXPO_PUBLIC_ZYROX_PREVIEW_TOKEN} …>
```

```ts
// SSR draft mode
fetchScreen({ …, previewToken });
// Any HTTP client
fetch(`${endpoint}/v1/bootstrap`, { headers: { authorization: `Bearer ${pk}`, 'x-zyrox-preview': token } });
```

- Every screen with a valid draft shows it (blocks use their drafts too); others show their release. `documents` limits the token to some keys.
- The token works with any environment's public key of the same project, and only that project.
- With a token, the client keeps nothing in storage (drafts never reach the offline cache) and sends no telemetry, so health numbers stay clean. Responses are `no-store`.
- Tokens are signed with `ZYROX_SECRET_KEY` and expire (5 minutes to 30 days, default 1 day). They can't be revoked one by one: rotating the secret key revokes all of them. Without a secret key they last until the server restarts. Treat a token like a password: anyone with it sees the project's drafts.

## Export and import

An export is one JSON file with a project's documents (drafts), environment settings, functions and webhooks (never their secrets) and, optionally, version history and releases:

```bash
zyrox export --project shop --versions -o shop.zyrox.json
zyrox import shop.zyrox.json --project shop-staging            # existing documents are kept
zyrox import shop.zyrox.json --project shop-staging --overwrite  # replace their drafts
```

Also in the dashboard (Settings → Previews & export) and the API (`GET /api/v1/projects/:project/export?versions=true`, `POST /api/v1/projects/:project/import` with `{ "bundle": …, "overwrite": false }`). Both need the admin role.

On import:

- Documents that don't exist are created with their draft; existing ones keep theirs unless `overwrite`.
- Version history is imported for documents that have no versions yet (recompiled on the target, so the refs match when the content does), along with releases of those versions in environments with the same key.
- Functions and webhooks that don't exist are created with **new secrets**, returned once in the response (and printed by the CLI): update your endpoints with them.
- The result lists what was created, updated, kept and any problems.

Uses: promote a whole project from a staging server to production, start projects from a template, move from PGlite to Postgres, or keep a portable copy next to your database backups. For screens in git, `zyrox pull` / `zyrox push` remain the day-to-day workflow.
