# Self-hosting Zyrox

One process serves everything: the public delivery API your apps call, the admin API, the dashboard, the live-preview WebSockets, and the MCP endpoint for AI agents. It needs Node 22+ and either Postgres (production) or its embedded database (PGlite, for trying it out and small installs).

- [Quick start](#quick-start)
- [Docker](#docker)
- [Configuration](#configuration)
- [Database](#database)
- [First run, users and roles](#first-run-users-and-roles)
- [Projects, environments and keys](#projects-environments-and-keys)
- [Reverse proxy, HTTPS and WebSockets](#reverse-proxy-https-and-websockets)
- [CDN](#cdn)
- [Scaling](#scaling)
- [Remote functions](#remote-functions)
- [AI assistant, translation and MCP](#ai-assistant-translation-and-mcp)
- [Embedding the server in your Node app](#embedding-the-server-in-your-node-app)
- [Operations: health, logs, backups, upgrades](#operations-health-logs-backups-upgrades)
- [Security checklist](#security-checklist)
- [HTTP API overview](#http-api-overview)
- [Troubleshooting](#troubleshooting)

## Quick start

```bash
git clone <this repository> zyrox && cd zyrox
pnpm install
pnpm --filter @wishyor/zyrox-dashboard build      # the server serves apps/dashboard/dist
pnpm --filter @wishyor/zyrox-server start          # http://localhost:4400
```

Open http://localhost:4400 and create the owner account. Data goes to `packages/server/.zyrox-data` (embedded PGlite). For anything shared, use Postgres and Docker as below.

## Docker

The repository's `Dockerfile` builds one image with the server and the dashboard (about 460 MB, `node:22-slim` base, runs as the `node` user):

```bash
docker build -t zyrox .
```

With Postgres (recommended):

```bash
docker run -d --name zyrox -p 4400:4400 \
  -e DATABASE_URL=postgres://zyrox:secret@db:5432/zyrox \
  -e ZYROX_PUBLIC_URL=https://ui.example.com \
  -e ZYROX_SECURE_COOKIES=true \
  zyrox
```

With the embedded database, keep `/data` on a volume:

```bash
docker run -d --name zyrox -p 4400:4400 -v zyrox-data:/data zyrox
```

A complete `docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: zyrox
      POSTGRES_PASSWORD: change-me
      POSTGRES_DB: zyrox
    volumes: [db:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U zyrox"]
      interval: 5s
  zyrox:
    build: .
    depends_on:
      db: { condition: service_healthy }
    ports: ["4400:4400"]
    environment:
      DATABASE_URL: postgres://zyrox:change-me@db:5432/zyrox
      ZYROX_PUBLIC_URL: https://ui.example.com
      ZYROX_SECURE_COOKIES: "true"
      # ANTHROPIC_API_KEY: sk-ant-…          # editor assistant + default translator
      # ZYROX_RUNTIME_TRANSLATION: "true"
volumes:
  db:
```

Migrations run automatically on start, for both databases.

## Configuration

All settings are environment variables (or options of `createZyroxServer`, see [embedding](#embedding-the-server-in-your-node-app)).

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4400` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATABASE_URL` | `./.zyrox-data` | `postgres://…` for Postgres; a directory for embedded PGlite; `memory://` for throwaway runs |
| `ZYROX_PUBLIC_URL` | request origin | Public origin, used in preview links. Set it behind a proxy |
| `ZYROX_SECURE_COOKIES` | `false` | Mark session cookies `Secure`. Set `true` when served over HTTPS |
| `ZYROX_OPEN_SIGNUP` | `false` | Anyone can sign up. Otherwise only the first user (the owner) can; the owner creates the rest |
| `ZYROX_DASHBOARD_DIR` | `apps/dashboard/dist` if built | Static dashboard to serve at `/` |
| `ZYROX_SECRET_KEY` | | Encrypts stored webhook secrets (AES-256-GCM). Set a long random value in production and keep it; secrets stored with it can't be read without it |
| `ZYROX_TRUST_PROXY` | `false` | Take the client IP from `X-Forwarded-For` (for rate limits). Set `true` only behind your own proxy or CDN |
| `ZYROX_RATE_LIMITS` | on | `off` disables built-in rate limiting (e.g. when your gateway does it) |
| `ZYROX_ALLOW_PRIVATE_URLS` | `false` | Let webhooks call private/local addresses and plain `http://`. Development only |
| `ZYROX_CORS_ORIGINS` | | Comma-separated origins allowed to call the admin API from a browser with a bearer token (custom admin UIs) |
| `ANTHROPIC_API_KEY` | | Enables the editor assistant and Claude as the default translator |
| `ZYROX_AI` | on when a key is set | `false` disables the assistant |
| `ZYROX_AI_MODEL` | `claude-opus-5-5` | Model for the assistant (and Claude translation) |
| `ZYROX_AI_EFFORT` | `medium` | `low`, `medium` or `high` |
| `ZYROX_TRANSLATOR` | `claude` when a key is set | `claude`, `deepl`, `libretranslate`, `webhook` or `off` |
| `ZYROX_TRANSLATOR_URL` | | LibreTranslate base URL, webhook URL, or a DeepL endpoint override |
| `ZYROX_TRANSLATOR_KEY` | | DeepL key, LibreTranslate key, or the webhook's bearer token |
| `ZYROX_RUNTIME_TRANSLATION` | `false` | Let apps machine-translate missing strings through `/v1/translate` |

## Database

**Postgres** (tested with 17) is the production choice. One database per installation; Zyrox creates its tables and a `drizzle` schema for migration bookkeeping. A small instance is plenty: delivery reads are served from memory (see [scaling](#scaling)), and Postgres sees writes from editors plus aggregated telemetry counters (flushed every 10 seconds per server).

**PGlite** is Postgres compiled to WebAssembly, running inside the server process with its data in a directory. Good for evaluation, single-user installs and tests. It allows one process per directory, so don't scale it out.

Tables, briefly: `users`, `sessions`, `api_tokens`, `projects`, `members`, `environments`, `documents`, `drafts`, `versions` (immutable), `releases`, `experiments`, `manifests`, `manifest_traffic`, `functions`, `telemetry`, `audit_log`. Documents, versions and manifests are stored as `json` (not `jsonb`) so authored key order is kept.

## First run, users and roles

1. The first person to sign up becomes the **owner** (admin on every project). Sign-up then closes unless `ZYROX_OPEN_SIGNUP=true`.
2. The owner creates accounts (`POST /api/users` with `{ email, password, name }`), and project admins add members under Settings → Members.

| Role | Can |
| --- | --- |
| `viewer` | See everything in a project |
| `editor` | Edit drafts and translations, upload manifests, test functions, use the assistant, create preview sessions |
| `publisher` | Publish versions, change releases, rollouts and experiments, promote between environments |
| `admin` | Manage members, environments, keys and remote functions; archive documents |

Sessions last 30 days, in an HTTP-only `SameSite=Lax` cookie; the session token never appears in a response body and isn't accepted as a bearer token. After 10 wrong passwords an account is locked for 15 minutes.

For CI and AI agents, create **personal access tokens** (`zyx_…`) under Settings → Access tokens. Give each one the smallest scope that works: one project or all, a maximum role (read only, up to editor, up to publisher, or your full role), and an expiry. Restricted tokens can't create tokens, users or projects. Tokens are stored hashed and can be revoked any time.

## Projects, environments and keys

Each project (usually one per app) gets three environments: `dev`, `staging`, `prod`. Each environment has:

- a **public key** (`pk_<env>_…`) that apps use. It's read-only: released documents and translations, functions, telemetry. It can be rotated in Settings → Environments;
- a **TTL** (default 60 s) that says how long apps reuse a bootstrap before revalidating;
- its own releases: which version of each document it serves, with rules, rollouts and experiments.

Ship different keys per build flavour (`pk_dev_…` in debug builds, `pk_prod_…` in store builds).

## Reverse proxy, HTTPS and WebSockets

Terminate TLS in front of Zyrox and pass WebSocket upgrades through (live preview uses `/v1/preview/*` and `/api/preview/*`).

**Caddy:**

```
ui.example.com {
  encode zstd gzip
  reverse_proxy localhost:4400
}
```

**nginx:**

```nginx
server {
  listen 443 ssl http2;
  server_name ui.example.com;
  # ssl_certificate …; ssl_certificate_key …;

  location / {
    proxy_pass http://127.0.0.1:4400;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;        # long-lived preview sockets and AI streams
    proxy_buffering off;             # stream the assistant's NDJSON responses
  }
}
```

Then set `ZYROX_PUBLIC_URL=https://ui.example.com` and `ZYROX_SECURE_COOKIES=true`. If the dashboard and the API are on different hosts, serve both from the same origin (the dashboard uses same-origin cookies).

## CDN

Put a CDN in front of the delivery API:

| Path | Cache |
| --- | --- |
| `/v1/docs/*`, `/v1/strings/*` | Cache forever. They're content-addressed and immutable (`cache-control: public, max-age=31536000, immutable`), precompressed with Brotli or gzip (`vary: accept-encoding`) |
| `/v1/bootstrap` | Never at a shared cache. It's per user (`private, no-cache`) and revalidated with an ETag |
| `/v1/functions/*`, `/v1/telemetry`, `/v1/translate` | Pass through |
| `/api/*`, `/mcp` | Pass through, no caching |

Apps can use the CDN hostname as `endpoint` if it forwards every `/v1/*` path to the server.

## Scaling

- **Stateless delivery.** Each server keeps an in-memory snapshot of every environment's releases (refreshed every 5 seconds, and immediately on the server that handled a publish), so a bootstrap costs a few map lookups and no database query. Immutable documents are cached in memory (2,000 most recently used) with their compressed forms.
- **Horizontal scaling** works behind any load balancer with Postgres. A publish is visible on other instances within 5 seconds, plus the app's TTL.
- **Live preview sessions** are held in memory by the server that created them. Use sticky sessions for `/api/preview/*` and `/v1/preview/*`, or route previews to one instance.
- **Runtime translation** caches and rate limits per instance (30 model calls per minute per environment).
- **Telemetry** is counted in memory and flushed every 10 seconds per instance; a crash loses at most that window.

## Remote functions

Documents can call functions: `{ "do": "call", "fn": "applyCoupon", "args": { … }, "into": "quote" }`. Two kinds:

**Webhooks to your cloud** (Settings → Functions, admins). Zyrox POSTs `{ fn, args, context }` with an HMAC signature; return JSON (or `{ "result": … }`). `context.user` is the id the app reported (for rollouts) and is **not** authenticated. To know who is calling, give the provider `userToken={() => auth.idToken}`: Zyrox forwards it as `x-zyrox-user-token`, and your function verifies it with your own auth:

```ts
// e.g. a Vercel / Cloud Run / Lambda handler
import { verifySignature } from '@wishyor/zyrox-server';

export async function POST(req: Request) {
  const body = await req.text();
  const ok = verifySignature(
    process.env.ZYROX_FUNCTION_SECRET!,                 // whsec_… shown when you create the function
    req.headers.get('x-zyrox-timestamp')!,
    body,
    req.headers.get('x-zyrox-signature')!,
  );
  if (!ok) return new Response('bad signature', { status: 401 });
  const { args, context } = JSON.parse(body);           // context: project, environment, user, attrs, screen, nodeId
  const caller = await verifyIdToken(req.headers.get('x-zyrox-user-token'));  // your auth (JWT, session…)
  return Response.json({ result: { total: args.amount * 0.9, for: caller.id } });
}
```

Requests time out after the configured timeout (default 10 s). Errors reach the document's `onError` with the function's message, and failures show on the Health page.

**Code functions** run inside the server process when you [embed the server](#embedding-the-server-in-your-node-app):

```ts
createZyroxServer({ functions: { applyCoupon: async (args, ctx) => ({ total: Number(args.amount) * 0.9 }) } });
```

## AI assistant, translation and MCP

**Editor assistant.** Set `ANTHROPIC_API_KEY`. Editors get an Assistant panel in the editor: describe a change or paste a screenshot, and Claude edits the draft with validated ops that use your components. It uses adaptive thinking, prompt caching of your component catalog, and server-side refusal fallbacks on models that support them. Prompts are logged in the audit log (first 200 characters).

**Translation providers.** One provider serves the dashboard's "Translate missing" button and runtime translation:

| `ZYROX_TRANSLATOR` | Needs |
| --- | --- |
| `claude` (default with `ANTHROPIC_API_KEY`) | |
| `deepl` | `ZYROX_TRANSLATOR_KEY` (free keys end with `:fx`) |
| `libretranslate` | `ZYROX_TRANSLATOR_URL` (self-hosted open models), optional `ZYROX_TRANSLATOR_KEY` |
| `webhook` | `ZYROX_TRANSLATOR_URL`. Your endpoint gets `{ sourceLocale, locale, messages, context }` and returns `{ messages }`: put any model behind it (an LLM on Ollama or vLLM, NLLB, Google Translate…) |

In code you can also pass `textTranslator(name, (texts, { sourceLocale, locale }) => …)` for any plain-text model (placeholders and plurals are protected for you), or a custom `{ name, translate }`. Results whose placeholders differ from the source are discarded.

**Runtime translation** (`ZYROX_RUNTIME_TRANSLATION=true`): apps fetch translations for keys missing in the user's language from `/v1/translate`. Apps send keys only; the server translates its own released source strings, so the public key can't be used to translate arbitrary text. Results are cached per source bundle and rate limited.

**MCP for AI agents.** `https://ui.example.com/mcp` (Streamable HTTP), authenticated with a personal access token:

```bash
claude mcp add --transport http zyrox https://ui.example.com/mcp --header "Authorization: Bearer $ZYROX_TOKEN"
```

Agents get design context, a component map, tokens, design-system rules, scaffolding, validated draft edits and live device previews. They can't publish or release; people do that. `npx zyrox mcp` prints the setup; `npx zyrox skills install` adds the guides to a repository.

## Embedding the server in your Node app

`@wishyor/zyrox-server` exports the whole server, so you can add code functions, a custom translator, or mount it in an existing app:

```ts
import { createZyroxServer, deeplTranslator } from '@wishyor/zyrox-server';

const zyrox = await createZyroxServer({
  database: process.env.DATABASE_URL,           // postgres://…, a directory, or memory://
  dashboardDir: './dashboard',                  // a copy of apps/dashboard/dist (pnpm --filter @wishyor/zyrox-dashboard build)
  publicUrl: 'https://ui.example.com',
  secureCookies: true,
  openSignup: false,
  functions: {
    applyCoupon: async (args, ctx) => ({ total: Number(args.amount) * 0.9, user: ctx.user }),
  },
  translator: deeplTranslator({ apiKey: process.env.DEEPL_KEY! }),
  runtimeTranslation: true,
  ai: { apiKey: process.env.ANTHROPIC_API_KEY, model: 'claude-opus-5-5', effort: 'medium' },  // or false
});

await zyrox.listen(4400);                       // HTTP + WebSockets
// or mount the Hono app elsewhere: zyrox.app.fetch(request)
process.on('SIGTERM', () => void zyrox.close()); // flushes counters, closes the database
```

`zyrox.app` is a [Hono](https://hono.dev) app (`fetch(request) → Response`), so it also runs behind any Fetch-API host. WebSockets (live preview) need `listen()` or `@hono/node-server`.

## Operations: health, logs, backups, upgrades

- **Health check:** `GET /healthz` → `{ "ok": true }`.
- **Logs:** stdout/stderr. Unhandled errors are logged with `[zyrox]`; API errors return `{ "error": { "message", "code", "details" } }`.
- **Audit log:** every publish, release change, rollback, function change, manifest upload, assistant prompt and translation run, under Settings → Audit log.
- **Backups:** Postgres with your usual tooling (`pg_dump`, managed snapshots). For PGlite, stop the server and copy the data directory. Published versions are immutable, so restoring an older backup never changes what a version hash means.
- **Upgrades:** pull, rebuild the image, restart. Migrations apply on start and are forward-only; back up first. Apps keep working during the restart from their caches.
- **Exporting content:** `zyrox pull` writes every draft to JSON files; documents in git are a good second backup. `zyrox export --versions` writes the whole project (drafts, history, releases, settings without secrets) as one file you can import on another server ([headless guide](headless.md#export-and-import)).
- **Webhooks:** notify CI, CDNs or chat of publishes and releases (Settings → Webhooks, [headless guide](headless.md#webhooks)).

## Security checklist

- Serve over HTTPS; set `ZYROX_SECURE_COOKIES=true` (also enables HSTS) and `ZYROX_PUBLIC_URL`.
- Set `ZYROX_SECRET_KEY` so webhook secrets are encrypted at rest and draft preview tokens survive restarts (rotating it revokes every preview token).
- Behind a proxy, set `ZYROX_TRUST_PROXY=true` so rate limits see real client IPs.
- Keep `ZYROX_OPEN_SIGNUP` off; add people as members with the smallest role they need.
- Give CI and agents personal access tokens from dedicated accounts; revoke unused ones.
- Built in: rate limits per client IP (sign-in 20/min, delivery 1,200/min, functions and telemetry 300/min, admin API 1,200/min; configurable via `rateLimits`), account lockout, request size limits (256 KB for `/v1`, 2 MB for the admin API, 16 MB for imports and assistant screenshots), and security headers (CSP, `frame-ancestors 'self'`, nosniff, referrer policy, HSTS with HTTPS).
- Webhook URLs must be `https://` and can't resolve to private, loopback, link-local or metadata addresses (checked on every connection, so DNS tricks don't help).
- Verify webhook signatures in your functions and keep their secrets in a secret manager; rotate under Settings → Functions.
- Public keys are meant to be in apps. If one leaks into the wrong build, rotate it under Settings → Environments.
- Keep personal data and secrets out of documents (they're public and cached); load user data from your API through the app's fetcher.

## HTTP API overview

**Delivery** (`/v1`, public key as `Authorization: Bearer pk_…`, CORS open):

| Endpoint | |
| --- | --- |
| `GET /v1/bootstrap` | Per-user map of document keys to version refs, translations, experiments. Headers: `x-zyrox-client` (`platform=ios; app=3.4.1; manifest=m_…; protocol=1`), `x-zyrox-user`, `x-zyrox-attrs`, `accept-language`, `if-none-match`, `x-zyrox-preview` (draft preview token) |
| `GET /v1/screens/:key` | One screen for this user, in one request (server-side rendering): `{ key, ref, document, experiment? }` |
| `GET /v1/docs/:ref` | Immutable document |
| `GET /v1/strings/:ref` | Immutable translation bundle |
| `POST /v1/functions/:name` | `{ args, screen, nodeId }` → `{ result }` |
| `POST /v1/telemetry` | `{ events: [{ type, screen, version, count, … }] }` |
| `POST /v1/translate` | `{ locale, keys }` → `{ messages }` (when enabled) |
| `GET /v1/preview/:id?token=` | Device side of live preview (WebSocket) |

**Admin** (`/api/v1`, also at `/api`; session cookie or `Authorization: Bearer zyx_…`; full OpenAPI 3.1 description at `GET /api/v1/openapi.json`): auth and tokens (`/api/auth/*`, `/api/me`, `/api/tokens`), projects and members, documents (`/api/projects/:p/documents/:key` with `draft`, `ops`, `validate`, `publish`, `versions`), releases (`/api/projects/:p/environments/:env/releases/:key`, `rollback`, `promote`), experiments, manifests, functions, health, audit, preview sessions and preview tokens, webhooks (`/api/projects/:p/webhooks`, `test`, `deliveries`), export and import, AI (`/api/ai/status`, `…/documents/:key/ai`, `/api/projects/:p/translate`). The CLI and dashboard use exactly this API. See the [headless guide](headless.md).

**MCP:** `POST /mcp` (Streamable HTTP, stateless).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| App shows `fallback` / "missing" | Is the document released to the environment of the app's public key (Releases page)? Does the app build's manifest have the components (publish shows the compatibility report)? |
| Changes take a while to appear | Apps revalidate after the environment TTL (60 s) and on foreground; a mounted screen keeps its version until reopened |
| Device preview never connects | WebSockets through your proxy (`Upgrade` headers), `ZYROX_PUBLIC_URL`, sticky sessions with several instances |
| Can't sign in after deploying behind HTTPS | Cookies are same-origin: serve the dashboard and `/api` from one host; set `ZYROX_SECURE_COOKIES=true` only with HTTPS |
| Assistant button missing | `ANTHROPIC_API_KEY` set? Settings → AI & agents shows what the server has enabled |
| PGlite errors in Docker | Mount a volume at `/data` (writable by the `node` user) |
