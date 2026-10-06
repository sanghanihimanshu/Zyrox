import { canonicalJson, hashString, type Manifest, manifestSchema, z } from '@zyrox/protocol';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { requireRole } from '../auth';
import type { AppEnv, ServerContext } from '../context';
import { newId, today } from '../crypto';
import { auditLog, environments, functions, manifests, telemetry, users } from '../db/schema';
import { fail, notFound } from '../errors';
import { audit } from '../services/audit';
import { FunctionError, newFunctionSecret, runFunction } from '../services/functions';
import { activeManifests } from '../services/publish';
import { assertCallableUrl } from '../services/safe-fetch';

const functionName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, 'Use letters, digits, "_", "." and "-"');

export function miscRoutes(ctx: ServerContext) {
  const app = new Hono<AppEnv>();
  const checkUrl = (url: string) => {
    try {
      assertCallableUrl(url, Boolean(ctx.options.allowPrivateUrls));
    } catch (err) {
      fail(400, err instanceof Error ? err.message : 'Invalid URL', 'invalid');
    }
  };
  const P = '/projects/:project';

  // --- App build manifests -------------------------------------------------------------------

  app.post(`${P}/manifests`, requireRole('editor'), async (c) => {
    const body = (await c.req.json()) as { manifest?: unknown; label?: string };
    const parsed = manifestSchema.safeParse(body.manifest);
    if (!parsed.success) fail(400, `Invalid manifest: ${parsed.error.issues[0]?.message}`, 'invalid');
    const { hash, ...rest } = parsed.data;
    if (`m_${hashString(canonicalJson(rest))}` !== hash)
      fail(400, 'Manifest hash does not match its content', 'invalid');
    await ctx.db
      .insert(manifests)
      .values({
        projectId: c.get('project').id,
        hash,
        content: parsed.data,
        label: String(body.label ?? '').slice(0, 100),
      })
      .onConflictDoUpdate({
        target: [manifests.projectId, manifests.hash],
        set: { label: String(body.label ?? '').slice(0, 100), uploadedAt: new Date() },
      });
    await audit(ctx.db, c.get('project').id, c.get('user').id, 'manifest.upload', hash, {
      label: body.label,
    });
    return c.json({ hash, components: Object.keys(parsed.data.components).length }, 201);
  });

  app.get(`${P}/manifests`, async (c) => {
    const project = c.get('project');
    const rows = await ctx.db
      .select()
      .from(manifests)
      .where(eq(manifests.projectId, project.id))
      .orderBy(desc(manifests.uploadedAt))
      .limit(50);
    const traffic = new Map((await activeManifests(ctx.db, project.id)).map((a) => [a.hash, a]));
    return c.json({
      manifests: rows.map((m, i) => ({
        hash: m.hash,
        label: m.label,
        uploadedAt: m.uploadedAt,
        latest: i === 0,
        share: traffic.get(m.hash)?.share ?? 0,
        requests: traffic.get(m.hash)?.count ?? 0,
        manifest: m.content as Manifest,
      })),
    });
  });

  // --- Remote functions (webhooks to your cloud) ---------------------------------------------

  app.get(`${P}/functions`, async (c) => {
    const rows = await ctx.db
      .select()
      .from(functions)
      .where(eq(functions.projectId, c.get('project').id))
      .orderBy(functions.name);
    const code = Object.keys(ctx.options.functions ?? {}).map((name) => ({ name, kind: 'code' as const }));
    return c.json({
      functions: [...code, ...rows.map(({ secret: _secret, ...f }) => ({ ...f, kind: 'webhook' as const }))],
    });
  });

  app.post(`${P}/functions`, requireRole('admin'), async (c) => {
    const input = z
      .object({
        name: functionName,
        url: z.url(),
        timeoutMs: z.number().int().min(100).max(60000).default(10000),
      })
      .parse(await c.req.json());
    if (ctx.options.functions?.[input.name])
      fail(409, `"${input.name}" is a code function on the server`, 'conflict');
    checkUrl(input.url);
    const secret = newFunctionSecret();
    const [row] = await ctx.db
      .insert(functions)
      .values({ id: newId('fn'), projectId: c.get('project').id, ...input, secret: ctx.secrets.seal(secret) })
      .returning();
    await audit(ctx.db, c.get('project').id, c.get('user').id, 'function.create', input.name, {
      url: input.url,
    });
    return c.json({ function: { ...row, secret } }, 201);
  });

  app.patch(`${P}/functions/:name`, requireRole('admin'), async (c) => {
    const input = z
      .object({
        url: z.url().optional(),
        timeoutMs: z.number().int().min(100).max(60000).optional(),
        enabled: z.boolean().optional(),
        rotateSecret: z.boolean().optional(),
      })
      .parse(await c.req.json());
    const { rotateSecret, ...rest } = input;
    if (rest.url) checkUrl(rest.url);
    const set: Partial<typeof functions.$inferInsert> = { ...rest };
    const secret = rotateSecret ? newFunctionSecret() : undefined;
    if (secret) set.secret = ctx.secrets.seal(secret);
    const [row] = await ctx.db
      .update(functions)
      .set(set)
      .where(and(eq(functions.projectId, c.get('project').id), eq(functions.name, c.req.param('name'))))
      .returning();
    if (!row) notFound('Function');
    await audit(ctx.db, c.get('project').id, c.get('user').id, 'function.update', row.name, {
      ...rest,
      rotateSecret,
    });
    const { secret: _stored, ...view } = row;
    return c.json({ function: secret ? { ...view, secret } : view, ...(secret ? { secret } : {}) });
  });

  app.delete(`${P}/functions/:name`, requireRole('admin'), async (c) => {
    await ctx.db
      .delete(functions)
      .where(and(eq(functions.projectId, c.get('project').id), eq(functions.name, c.req.param('name'))));
    await audit(ctx.db, c.get('project').id, c.get('user').id, 'function.delete', c.req.param('name'));
    return c.json({ ok: true });
  });

  app.post(`${P}/functions/:name/test`, requireRole('editor'), async (c) => {
    const project = c.get('project');
    const body = (await c.req.json().catch(() => ({}))) as { args?: Record<string, unknown>; env?: string };
    const [env] = await ctx.db
      .select()
      .from(environments)
      .where(and(eq(environments.projectId, project.id), eq(environments.key, body.env ?? 'dev')));
    try {
      const started = Date.now();
      const result = await runFunction(ctx, c.req.param('name'), body.args ?? {}, {
        project: { id: project.id, slug: project.slug },
        environment: { id: env?.id ?? '', key: env?.key ?? 'dev' },
        user: `dashboard:${c.get('user').id}`,
        attrs: {},
      });
      return c.json({ ok: true, result: result ?? null, durationMs: Date.now() - started });
    } catch (err) {
      return c.json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        status: err instanceof FunctionError ? err.status : 500,
      });
    }
  });

  // --- Health & audit ---------------------------------------------------------------------------

  app.get(`${P}/health`, async (c) => {
    const project = c.get('project');
    await ctx.counters.flush();
    const days = Math.min(Number(c.req.query('days') ?? 7), 90);
    const since = today(new Date(Date.now() - days * 86_400_000));
    const envKey = c.req.query('env') ?? 'prod';
    const [env] = await ctx.db
      .select()
      .from(environments)
      .where(and(eq(environments.projectId, project.id), eq(environments.key, envKey)));
    if (!env) notFound('Environment');
    const rows = await ctx.db
      .select({
        type: telemetry.type,
        subject: telemetry.subject,
        ref: telemetry.ref,
        kind: telemetry.kind,
        nodeId: telemetry.nodeId,
        message: sql<string>`max(${telemetry.message})`,
        count: sql<number>`sum(${telemetry.count})::int`,
      })
      .from(telemetry)
      .where(and(eq(telemetry.environmentId, env.id), gte(telemetry.day, since)))
      .groupBy(telemetry.type, telemetry.subject, telemetry.ref, telemetry.kind, telemetry.nodeId);
    const daily = await ctx.db
      .select({ day: telemetry.day, type: telemetry.type, count: sql<number>`sum(${telemetry.count})::int` })
      .from(telemetry)
      .where(and(eq(telemetry.environmentId, env.id), gte(telemetry.day, since)))
      .groupBy(telemetry.day, telemetry.type)
      .orderBy(telemetry.day);

    const screens = new Map<
      string,
      {
        views: number;
        errors: number;
        versions: Map<string, { views: number; errors: number }>;
        topErrors: typeof rows;
      }
    >();
    const screen = (key: string) => {
      let s = screens.get(key);
      if (!s) {
        s = { views: 0, errors: 0, versions: new Map(), topErrors: [] };
        screens.set(key, s);
      }
      return s;
    };
    const fnStats = new Map<string, { ok: number; error: number; lastError?: string }>();
    const exposures: Record<string, Record<string, number>> = {};
    for (const r of rows) {
      if (r.type === 'screen_view' || r.type === 'error') {
        const s = screen(r.subject);
        const v = s.versions.get(r.ref) ?? { views: 0, errors: 0 };
        if (r.type === 'screen_view') {
          s.views += r.count;
          v.views += r.count;
        } else {
          s.errors += r.count;
          v.errors += r.count;
          s.topErrors.push(r);
        }
        s.versions.set(r.ref, v);
      } else if (r.type === 'function') {
        const f = fnStats.get(r.subject) ?? { ok: 0, error: 0 };
        if (r.kind === 'ok') f.ok += r.count;
        else {
          f.error += r.count;
          f.lastError = r.message;
        }
        fnStats.set(r.subject, f);
      } else if (r.type === 'exposure') {
        exposures[r.subject] ??= {};
        exposures[r.subject]![r.ref] = (exposures[r.subject]![r.ref] ?? 0) + r.count;
      }
    }
    return c.json({
      environment: env.key,
      days,
      daily,
      screens: [...screens.entries()]
        .map(([key, s]) => ({
          key,
          views: s.views,
          errors: s.errors,
          errorRate: s.views ? s.errors / s.views : 0,
          versions: [...s.versions.entries()].map(([ref, v]) => ({
            ref,
            ...v,
            errorRate: v.views ? v.errors / v.views : 0,
          })),
          topErrors: s.topErrors
            .sort((a, b) => b.count - a.count)
            .slice(0, 10)
            .map((e) => ({ kind: e.kind, nodeId: e.nodeId, message: e.message, count: e.count, ref: e.ref })),
        }))
        .sort((a, b) => b.views - a.views),
      functions: [...fnStats.entries()].map(([name, f]) => ({ name, ...f })),
      experiments: exposures,
      builds: (await activeManifests(ctx.db, project.id, days)).map((a) => ({
        hash: a.hash,
        label: a.manifest?.label ?? '',
        share: a.share,
        requests: a.count,
      })),
    });
  });

  app.get(`${P}/audit`, async (c) => {
    const rows = await ctx.db
      .select({ entry: auditLog, actor: users.name })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorId))
      .where(eq(auditLog.projectId, c.get('project').id))
      .orderBy(desc(auditLog.createdAt))
      .limit(Math.min(Number(c.req.query('limit') ?? 100), 500));
    return c.json({ entries: rows.map((r) => ({ ...r.entry, actor: r.actor })) });
  });

  // --- Live preview sessions --------------------------------------------------------------------

  app.post(`${P}/preview-sessions`, requireRole('editor'), async (c) => {
    const session = ctx.preview.create(c.get('project').id);
    return c.json(session, 201);
  });

  return app;
}
