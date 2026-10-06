import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serve, upgradeWebSocket } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from '@zyrox/protocol';
import { and, eq } from 'drizzle-orm';
import { type Context, Hono, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { WebSocketServer } from 'ws';
import {
  authenticate,
  effectiveRole,
  requireProject,
  requireUser,
  roleAtLeast,
  SESSION_COOKIE,
} from './auth';
import type { AppEnv, RateLimits, ServerContext, ServerOptions } from './context';
import { type Database, openDatabase } from './db';
import { members, type Role } from './db/schema';
import { openApiDocument } from './openapi';
import { aiRoutes } from './routes/admin-ai';
import { authRoutes } from './routes/admin-auth';
import { documentRoutes } from './routes/admin-documents';
import { headlessRoutes } from './routes/admin-headless';
import { miscRoutes } from './routes/admin-misc';
import { projectRoutes } from './routes/admin-projects';
import { releaseRoutes } from './routes/admin-releases';
import { deliveryRoutes } from './routes/delivery';
import { mcpRoutes } from './routes/mcp';
import { createAiClient, DEFAULT_MODEL } from './services/ai';
import { onAudit } from './services/audit';
import { Counters } from './services/counters';
import { DeliveryCache } from './services/delivery-cache';
import { PreviewHub } from './services/preview';
import { PreviewTokens } from './services/preview-tokens';
import { RateLimiter, rateLimit } from './services/rate-limit';
import { RuntimeTranslator } from './services/runtime-translate';
import { SecretBox } from './services/secrets';
import { claudeTranslator } from './services/translation';
import { WebhookDispatcher } from './services/webhooks';

export interface ZyroxServer {
  app: Hono<AppEnv>;
  ctx: ServerContext;
  database: Database;
  /** Starts an HTTP server (with WebSockets for live preview). */
  listen(port?: number, hostname?: string): Promise<{ port: number; close(): Promise<void> }>;
  close(): Promise<void>;
}

/** Creates the Zyrox server: delivery API (`/v1`), admin API (`/api`), preview relay and dashboard. */
export async function createZyroxServer(options: ServerOptions = {}): Promise<ZyroxServer> {
  const database = await openDatabase(options.database ?? './.zyrox-data');
  const ctx: ServerContext = {
    db: database.db,
    options,
    counters: new Counters(database.db, options.counterIntervalMs ?? 10_000),
    preview: new PreviewHub(),
    delivery: new DeliveryCache(database.db),
    secrets: new SecretBox(options.secretKey),
  } as ServerContext;
  ctx.webhooks = new WebhookDispatcher(ctx);
  ctx.previewTokens = new PreviewTokens(options.secretKey);
  // Every audited change is also an outbound webhook event.
  onAudit(ctx.db, (projectId, actorId, action, target, details) =>
    ctx.webhooks.dispatch(projectId, actorId, action, target, details),
  );
  const aiOptions = options.ai === false ? undefined : (options.ai ?? {});
  const aiClient = aiOptions ? createAiClient(aiOptions) : undefined;
  if (aiOptions && aiClient) {
    ctx.ai = {
      client: aiClient,
      model: aiOptions.model || DEFAULT_MODEL,
      effort: aiOptions.effort,
    };
  }
  const translator =
    options.translator === false
      ? undefined
      : (options.translator ?? (ctx.ai ? claudeTranslator(ctx.ai) : undefined));
  if (translator) {
    ctx.translation = {
      provider: translator,
      runtime: options.runtimeTranslation ? new RuntimeTranslator(translator) : undefined,
    };
  }

  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      const cause = (err.cause ?? {}) as { code?: string; details?: unknown };
      return c.json(
        { error: { message: err.message, code: cause.code ?? 'error', details: cause.details } },
        err.status,
      );
    }
    if (err instanceof z.ZodError) {
      const issue = err.issues[0];
      const message = issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid request';
      return c.json({ error: { message, code: 'invalid', details: err.issues } }, 400);
    }
    if (err instanceof SyntaxError)
      return c.json({ error: { message: 'Invalid JSON body', code: 'invalid' } }, 400);
    console.error('[zyrox] unhandled error', err);
    return c.json({ error: { message: 'Internal server error', code: 'internal' } }, 500);
  });

  app.get('/healthz', (c) => c.json({ ok: true }));

  installSecurity(app, options);

  // Public delivery API used by apps.
  app.route('/v1', deliveryRoutes(ctx));

  // Live preview: devices join with the session token from the QR code.
  app.get(
    '/v1/preview/:id',
    upgradeWebSocket((c) => {
      const session = ctx.preview.get(c.req.param('id') ?? '');
      const authorized = session && c.req.query('token') === session.token;
      return {
        onOpen(_event, ws) {
          if (!authorized || !session) return ws.close(4401, 'Invalid preview session');
          ctx.preview.deviceJoined(session, ws);
        },
        onMessage(event, ws) {
          if (authorized && session) ctx.preview.deviceMessage(session, ws, String(event.data));
        },
        onClose(_event, ws) {
          if (authorized && session) ctx.preview.deviceLeft(session, ws);
        },
      };
    }),
  );

  // Admin API used by the dashboard, CLI and agents.
  const api = new Hono<AppEnv>();
  api.get('/openapi.json', (c) => c.json(openApiDocument()));
  api.route('/', authRoutes(ctx));
  api.route('/', projectRoutes(ctx));
  const scoped = new Hono<AppEnv>();
  scoped.use('*', requireUser(ctx));
  scoped.use('/projects/:project/*', requireProject(ctx));
  scoped.route('/', documentRoutes(ctx));
  scoped.route('/', releaseRoutes(ctx));
  scoped.route('/', miscRoutes(ctx));
  scoped.route('/', aiRoutes(ctx));
  scoped.route('/', headlessRoutes(ctx));
  api.route('/', scoped);
  // `/api/v1` is the stable, versioned path for integrations; `/api` stays for the dashboard.
  app.route('/api/v1', api);
  app.route('/api', api);

  // Model Context Protocol endpoint for AI agents (personal access token auth).
  app.route(
    '/mcp',
    mcpRoutes(ctx, (path, init) => Promise.resolve(app.request(`/api${path}`, init))),
  );

  // Editors join a preview session with their dashboard session.
  app.get(
    '/api/preview/:id/ws',
    upgradeWebSocket(async (c) => {
      const session = ctx.preview.get(c.req.param('id') ?? '');
      const auth = await authenticate(
        ctx,
        getCookie(c, SESSION_COOKIE),
        c.req.header('authorization') ??
          (c.req.query('token') ? `Bearer ${c.req.query('token')}` : undefined),
      );
      let allowed = false;
      if (session && auth) {
        let role: Role | undefined = auth.user.owner ? 'admin' : undefined;
        if (!role) {
          const [member] = await ctx.db
            .select()
            .from(members)
            .where(and(eq(members.projectId, session.projectId), eq(members.userId, auth.user.id)));
          role = member?.role;
        }
        const effective = effectiveRole(role, auth.scope, session.projectId);
        allowed = Boolean(effective && roleAtLeast(effective, 'viewer'));
      }
      return {
        onOpen(_event, ws) {
          if (!allowed || !session) return ws.close(4401, 'Not allowed');
          ctx.preview.editorJoined(session, ws);
        },
        onMessage(event) {
          if (allowed && session) ctx.preview.editorMessage(session, String(event.data));
        },
        onClose(_event, ws) {
          if (allowed && session) ctx.preview.editorLeft(session, ws);
        },
      };
    }),
  );

  // The dashboard (a static single-page app), when built.
  const dashboardDir = options.dashboardDir ? resolve(options.dashboardDir) : undefined;
  if (dashboardDir && existsSync(join(dashboardDir, 'index.html'))) {
    const indexHtml = readFileSync(join(dashboardDir, 'index.html'), 'utf8');
    app.use('/*', serveStatic({ root: dashboardDir }));
    app.get('*', (c) => {
      if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/v1/'))
        return c.json({ error: { message: 'Not found', code: 'not_found' } }, 404);
      return c.html(indexHtml);
    });
  }

  app.notFound((c) => c.json({ error: { message: 'Not found', code: 'not_found' } }, 404));

  const close = async () => {
    ctx.webhooks.stop();
    await ctx.webhooks.idle();
    await ctx.counters.close();
    await database.close();
  };

  return {
    app,
    ctx,
    database,
    close,
    listen: (port = 4400, hostname = '0.0.0.0') =>
      new Promise((resolveListen) => {
        const wss = new WebSocketServer({ noServer: true });
        const server = serve({ fetch: app.fetch, port, hostname, websocket: { server: wss } }, (info) => {
          resolveListen({
            port: info.port,
            close: () =>
              new Promise<void>((done) => {
                wss.close();
                server.close(() => done());
              }),
          });
        });
      }),
  };
}

const DEFAULT_LIMITS: RateLimits = { auth: 20, delivery: 1200, functions: 300, telemetry: 300, api: 1200 };

/** Security headers, request size limits, rate limits and CORS for token-based admin clients. */
function installSecurity(app: Hono<AppEnv>, options: ServerOptions): void {
  const dashboardHeaders = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:', 'http:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      workerSrc: ["'self'", 'blob:'],
      // The editor canvas loads each project's own preview URL.
      frameSrc: ["'self'", 'https:', 'http:'],
      frameAncestors: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
    strictTransportSecurity: options.secureCookies ? 'max-age=31536000; includeSubDomains' : false,
    crossOriginResourcePolicy: 'same-origin',
    referrerPolicy: 'strict-origin-when-cross-origin',
  });
  app.use('*', async (c, next) => {
    // The delivery API is public and cross-origin by design: only basic hardening.
    if (c.req.path.startsWith('/v1/')) {
      await next();
      c.header('x-content-type-options', 'nosniff');
      return;
    }
    return dashboardHeaders(c, next);
  });

  const tooLarge = (c: Context) =>
    c.json({ error: { message: 'Request body is too large', code: 'too_large' } }, 413);
  const limit = (maxSize: number) => bodyLimit({ maxSize, onError: tooLarge });
  const small = limit(256 * 1024);
  const regular = limit(2 * 1024 * 1024);
  const large = limit(16 * 1024 * 1024);
  app.use('/v1/*', small);
  app.use('/mcp', limit(4 * 1024 * 1024));
  app.use('/api/*', (c: Context, next: Next) =>
    // Screenshots for the assistant and project imports are larger.
    /\/(ai|import)$/.test(c.req.path) ? large(c, next) : regular(c, next),
  );

  if (options.corsOrigins?.length) {
    // Bearer tokens only: session cookies stay same-origin (SameSite=Lax).
    app.use(
      '/api/*',
      cors({
        origin: options.corsOrigins,
        allowHeaders: ['authorization', 'content-type'],
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        credentials: false,
      }),
    );
  }

  if (options.rateLimits === false) return;
  const limits = { ...DEFAULT_LIMITS, ...options.rateLimits };
  const trust = Boolean(options.trustProxy);
  const per = (n: number) => rateLimit(new RateLimiter(n), trust);
  const auth = per(limits.auth);
  app.use('/api/auth/login', auth);
  app.use('/api/auth/signup', auth);
  app.use('/api/v1/auth/login', auth);
  app.use('/api/v1/auth/signup', auth);
  const delivery = per(limits.delivery);
  for (const path of ['/v1/bootstrap', '/v1/docs/*', '/v1/strings/*']) app.use(path, delivery);
  app.use('/v1/functions/*', per(limits.functions));
  const telemetry = per(limits.telemetry);
  app.use('/v1/telemetry', telemetry);
  app.use('/v1/translate', telemetry);
  const api = per(limits.api);
  app.use('/api/*', api);
  app.use('/mcp', api);
}
