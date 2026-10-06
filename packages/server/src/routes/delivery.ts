import { pickLocale } from '@wishyor/zyrox-core';
import { hashString, z } from '@wishyor/zyrox-protocol';
import { type Context, Hono } from 'hono';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import type { ServerContext } from '../context';
import { fail } from '../errors';
import { FunctionError, runFunction } from '../services/functions';
import { draftRefs, type PreviewClaims } from '../services/preview-tokens';
import { resolveRelease, type TargetingContext } from '../services/rules';

function parseHeader(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (value ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    try {
      out[decodeURIComponent(part.slice(0, eq).trim())] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // ignore malformed pairs
    }
  }
  return out;
}

function parseLocales(header: string | undefined): string[] {
  return (header ?? '')
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      return { tag: tag?.trim() ?? '', q: q ? Number(q.trim().slice(2)) : 1 };
    })
    .filter((l) => l.tag && l.tag !== '*')
    .sort((a, b) => b.q - a.q)
    .map((l) => l.tag);
}

const telemetrySchema = z.object({
  events: z
    .array(
      z.object({
        type: z.enum(['screen_view', 'error', 'exposure']),
        screen: z.string().max(200).optional(),
        version: z.string().max(100).optional(),
        kind: z.string().max(50).optional(),
        nodeId: z.string().max(200).optional(),
        message: z.string().max(500).optional(),
        experiment: z.string().max(200).optional(),
        variant: z.string().max(200).optional(),
        count: z.number().int().min(1).max(100000).default(1),
      }),
    )
    .max(500),
});

/** Public, read-only API used by apps: bootstrap, immutable documents, functions, telemetry. */
export function deliveryRoutes(ctx: ServerContext) {
  const app = new Hono();
  app.use(
    '*',
    cors({
      origin: '*',
      allowHeaders: [
        'authorization',
        'content-type',
        'x-zyrox-client',
        'x-zyrox-user',
        'x-zyrox-attrs',
        'accept-language',
        'if-none-match',
        'x-zyrox-preview',
      ],
      exposeHeaders: ['etag'],
    }),
  );
  // Bootstrap and function results; immutable content is served precompressed.
  app.use('/bootstrap', compress());
  app.use('/screens/*', compress());
  app.use('/functions/*', compress());

  const environmentFor = async (authorization: string | undefined) => {
    const key = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!key.startsWith('pk_')) fail(401, 'Missing public key', 'unauthorized');
    const env = await ctx.delivery.environment(key);
    if (!env) fail(401, 'Unknown public key', 'unauthorized');
    return env;
  };

  const targeting = (headers: (name: string) => string | undefined): TargetingContext => {
    const client = parseHeader(headers('x-zyrox-client'));
    return {
      user: { id: headers('x-zyrox-user')?.slice(0, 200) || 'anonymous' },
      client: {
        platform: client.platform ?? 'unknown',
        app: client.app ?? '',
        manifest: client.manifest ?? '',
        protocol: Number(client.protocol ?? 1),
      },
      attrs: parseHeader(headers('x-zyrox-attrs')),
      locale: parseLocales(headers('accept-language'))[0] ?? '',
    };
  };

  /** A draft preview token for this environment's project, if the request carries one. */
  const previewFor = (c: Context, projectId: string): PreviewClaims | undefined => {
    const token = c.req.header('x-zyrox-preview');
    if (!token) return undefined;
    const claims = ctx.previewTokens.verify(token);
    if (!claims || claims.p !== projectId) fail(401, 'Invalid or expired preview token', 'invalid_preview');
    return claims;
  };

  app.get('/bootstrap', async (c) => {
    const env = await environmentFor(c.req.header('authorization'));
    const preview = previewFor(c, env.project.id);
    const t = targeting((n) => c.req.header(n));
    if (t.client.manifest) ctx.counters.manifest(env.environment.id, t.client.manifest);
    const docs: Record<string, string> = {};
    const strings: Record<string, string> = {};
    const exposures = new Map<string, { key: string; variant: string; docs: string[] }>();
    for (const release of env.releases) {
      const resolved = resolveRelease(release, t, env.experiments);
      const version = env.versions.get(resolved.versionId);
      if (!version) continue;
      if (release.kind === 'strings') {
        if (version.locale) strings[version.locale] = version.ref;
        continue;
      }
      docs[release.documentKey] = version.ref;
      if (resolved.experiment) {
        const existing = exposures.get(resolved.experiment.key);
        if (existing) existing.docs.push(release.documentKey);
        else exposures.set(resolved.experiment.key, { ...resolved.experiment, docs: [release.documentKey] });
      }
    }
    const body = JSON.stringify({
      ttl: env.environment.ttl,
      docs,
      strings: {
        defaultLocale: env.project.defaultLocale,
        refs: strings,
        translate: Boolean(ctx.translation?.runtime),
        suggested: pickLocale(
          parseLocales(c.req.header('accept-language')),
          Object.keys(strings),
          env.project.defaultLocale,
        ),
      },
      experiments: [...exposures.values()],
    });
    if (preview) {
      // Drafts instead of releases, never cached anywhere.
      const drafts = await draftRefs(ctx, env.project.id, preview.d);
      const parsed = JSON.parse(body) as { docs: Record<string, string>; experiments: { docs: string[] }[] };
      Object.assign(parsed.docs, Object.fromEntries(drafts));
      parsed.experiments = parsed.experiments.filter((e) => !e.docs.some((d) => drafts.has(d)));
      c.header('cache-control', 'private, no-store');
      return c.json({ ...parsed, preview: true });
    }
    // Per user, so never shared; but revalidated cheaply: unchanged bootstraps cost a 304.
    const etag = `"b_${hashString(body)}"`;
    c.header('cache-control', 'private, no-cache');
    c.header('etag', etag);
    c.header('vary', 'authorization, x-zyrox-client, x-zyrox-user, x-zyrox-attrs, accept-language');
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);
    c.header('content-type', 'application/json; charset=utf-8');
    return c.body(body);
  });

  const immutable = (prefix: string) => async (c: Context) => {
    const ref = c.req.param('ref') ?? '';
    if (!ref.startsWith(prefix)) fail(404, 'Not found', 'not_found');
    c.header('cache-control', 'public, max-age=31536000, immutable');
    c.header('etag', `"${ref}"`);
    c.header('vary', 'accept-encoding');
    if (c.req.header('if-none-match') === `"${ref}"`) return c.body(null, 304);
    const content = await ctx.delivery.content(ref);
    if (content === undefined) fail(404, 'Not found', 'not_found');
    c.header('content-type', 'application/json; charset=utf-8');
    const accepts = c.req.header('accept-encoding') ?? '';
    const encoding = /\bbr\b/.test(accepts) ? 'br' : /\bgzip\b/.test(accepts) ? 'gzip' : undefined;
    if (!encoding || content.json.length < 1024) return c.body(content.json);
    c.header('content-encoding', encoding);
    return c.body(new Uint8Array(await content.encoded(encoding)));
  };
  app.get('/docs/:ref', immutable('d_'));

  // One screen as this client would get it, in a single request: for server-side rendering
  // (Next.js, Remix, Expo Router API routes) and headless use.
  app.get('/screens/:key{.+}', async (c) => {
    const env = await environmentFor(c.req.header('authorization'));
    const preview = previewFor(c, env.project.id);
    const key = c.req.param('key');
    const t = targeting((n) => c.req.header(n));
    let ref: string | undefined;
    let experiment: { key: string; variant: string } | undefined;
    if (preview && (!preview.d || preview.d.includes(key)))
      ref = (await draftRefs(ctx, env.project.id, [key])).get(key);
    if (!ref) {
      const release = env.releases.find((r) => r.documentKey === key && r.kind !== 'strings');
      if (release) {
        const resolved = resolveRelease(release, t, env.experiments);
        ref = env.versions.get(resolved.versionId)?.ref;
        if (resolved.experiment)
          experiment = { key: resolved.experiment.key, variant: resolved.experiment.variant };
      }
    }
    const content = ref ? await ctx.delivery.content(ref) : undefined;
    if (!ref || !content) fail(404, `No released screen "${key}"`, 'not_found');
    c.header('cache-control', preview ? 'private, no-store' : 'private, no-cache');
    c.header('etag', `"${ref}"`);
    c.header(
      'vary',
      'authorization, x-zyrox-client, x-zyrox-user, x-zyrox-attrs, accept-language, x-zyrox-preview',
    );
    if (c.req.header('if-none-match') === `"${ref}"`) return c.body(null, 304);
    c.header('content-type', 'application/json; charset=utf-8');
    const head = JSON.stringify({
      key,
      ref,
      ...(experiment ? { experiment } : {}),
      ...(preview ? { preview: true } : {}),
    });
    return c.body(`${head.slice(0, -1)},"document":${content.json}}`);
  });
  app.get('/strings/:ref', immutable('s_'));

  app.post('/functions/:name', async (c) => {
    const env = await environmentFor(c.req.header('authorization'));
    const name = c.req.param('name');
    const body = (await c.req.json().catch(() => ({}))) as {
      args?: unknown;
      screen?: string;
      nodeId?: string;
    };
    const args =
      body.args && typeof body.args === 'object' && !Array.isArray(body.args)
        ? (body.args as Record<string, unknown>)
        : {};
    const t = targeting((n) => c.req.header(n));
    try {
      const userToken = c.req.header('x-zyrox-user-token');
      const result = await runFunction(ctx, name, args, {
        ...(userToken ? { userToken: userToken.slice(0, 8192) } : {}),
        project: { id: env.project.id, slug: env.project.slug },
        environment: { id: env.environment.id, key: env.environment.key },
        user: t.user.id,
        attrs: t.attrs,
        screen: typeof body.screen === 'string' ? body.screen : undefined,
        nodeId: typeof body.nodeId === 'string' ? body.nodeId : undefined,
      });
      ctx.counters.event({
        environmentId: env.environment.id,
        type: 'function',
        subject: name,
        ref: '',
        kind: 'ok',
        nodeId: '',
        message: '',
      });
      return c.json({ result: result ?? null });
    } catch (err) {
      const status = err instanceof FunctionError ? err.status : 500;
      const message = err instanceof Error ? err.message : 'Function failed';
      ctx.counters.event({
        environmentId: env.environment.id,
        type: 'function',
        subject: name,
        ref: '',
        kind: 'error',
        nodeId: '',
        message: message.slice(0, 300),
      });
      return c.json({ error: { message } }, status as 404 | 500);
    }
  });

  // Machine translation of missing strings (opt-in: ZYROX_RUNTIME_TRANSLATION). Clients send
  // keys only; the text comes from the environment's released source-locale bundle.
  app.post('/translate', async (c) => {
    const env = await environmentFor(c.req.header('authorization'));
    const translator = ctx.translation?.runtime;
    if (!translator) fail(404, 'Runtime translation is not enabled on this server', 'disabled');
    const body = z
      .object({
        locale: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/),
        keys: z.array(z.string().min(1).max(200)).min(1).max(100),
      })
      .parse(await c.req.json());
    const sourceLocale = env.project.defaultLocale;
    if (body.locale === sourceLocale) return c.json({ messages: {} });
    const sourceRef = env.releases
      .filter((r) => r.kind === 'strings')
      .map((r) => env.versions.get(r.defaultVersionId))
      .find((v) => v?.locale === sourceLocale)?.ref;
    const bundle = sourceRef ? await ctx.delivery.content(sourceRef) : undefined;
    if (!sourceRef || !bundle) return c.json({ messages: {} });
    const source = (JSON.parse(bundle.json) as { messages?: Record<string, string> }).messages ?? {};
    try {
      const messages = await translator.translate({
        environmentId: env.environment.id,
        project: env.project.name,
        sourceRef,
        sourceLocale,
        source,
        locale: body.locale,
        keys: [...new Set(body.keys)],
      });
      c.header('cache-control', 'no-store');
      return c.json({ messages });
    } catch (err) {
      console.warn('[zyrox] runtime translation failed', err);
      return c.json({ messages: {} });
    }
  });

  app.post('/telemetry', async (c) => {
    const env = await environmentFor(c.req.header('authorization'));
    const parsed = telemetrySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) fail(400, 'Invalid telemetry payload', 'invalid');
    for (const e of parsed.data.events) {
      ctx.counters.event(
        {
          environmentId: env.environment.id,
          type: e.type,
          subject: (e.type === 'exposure' ? e.experiment : e.screen) ?? '',
          ref: (e.type === 'exposure' ? e.variant : e.version) ?? '',
          kind: e.kind ?? '',
          nodeId: e.nodeId ?? '',
          message: e.message ?? '',
        },
        e.count,
      );
    }
    return c.json({ ok: true });
  });

  return app;
}
