import { z } from '@wishyor/zyrox-protocol';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { requireRole } from '../auth';
import type { AppEnv, ServerContext } from '../context';
import { newId } from '../crypto';
import {
  type DocumentKind,
  documents,
  drafts,
  environments,
  functions,
  type ReleaseRule,
  releases,
  versions,
  webhookDeliveries,
  webhooks,
} from '../db/schema';
import { fail, notFound } from '../errors';
import { audit } from '../services/audit';
import { newFunctionSecret } from '../services/functions';
import { compileDraft } from '../services/publish';
import { assertCallableUrl } from '../services/safe-fetch';

const eventPattern = z
  .string()
  .regex(/^(\*|[a-z_]+\.\*|[a-z_]+(\.[a-z_]+)*)$/, 'Use an event name, a prefix like "release.*", or "*"');

/** Version 1 of the project export format (`zyrox export`). */
const exportSchema = z.object({
  zyrox: z.literal('project'),
  version: z.literal(1),
  project: z.object({ name: z.string(), slug: z.string(), defaultLocale: z.string().optional() }).optional(),
  environments: z
    .array(
      z.object({ key: z.string(), name: z.string().optional(), ttl: z.number().int().min(0).optional() }),
    )
    .default([]),
  documents: z
    .array(
      z.object({
        key: z.string().min(1).max(200),
        kind: z.enum(['screen', 'block', 'strings']),
        title: z.string().max(200).default(''),
        description: z.string().max(1000).default(''),
        draft: z.unknown(),
        versions: z
          .array(
            z.object({
              number: z.number().int().min(1),
              message: z.string().default(''),
              source: z.unknown(),
            }),
          )
          .optional(),
      }),
    )
    .max(5000)
    .default([]),
  functions: z
    .array(
      z.object({
        name: z.string(),
        url: z.string(),
        timeoutMs: z.number().int().min(100).max(60000).default(10000),
        enabled: z.boolean().default(true),
      }),
    )
    .default([]),
  webhooks: z
    .array(
      z.object({
        url: z.string(),
        events: z.array(z.string()).default(['*']),
        description: z.string().default(''),
        enabled: z.boolean().default(true),
      }),
    )
    .default([]),
  releases: z
    .array(
      z.object({
        environment: z.string(),
        document: z.string(),
        version: z.number().int().min(1),
        rules: z.array(z.record(z.string(), z.unknown())).default([]),
      }),
    )
    .default([]),
});

/** Webhooks, draft preview tokens and project export/import: the headless side of the admin API. */
export function headlessRoutes(ctx: ServerContext) {
  const app = new Hono<AppEnv>();
  const P = '/projects/:project';
  const checkUrl = (url: string) => {
    try {
      assertCallableUrl(url, Boolean(ctx.options.allowPrivateUrls));
    } catch (err) {
      fail(400, err instanceof Error ? err.message : 'Invalid URL', 'invalid');
    }
  };
  const view = ({ secret: _secret, ...hook }: typeof webhooks.$inferSelect) => hook;
  const loadHook = async (projectId: string, id: string) => {
    const [hook] = await ctx.db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.projectId, projectId), eq(webhooks.id, id)));
    if (!hook) notFound('Webhook');
    return hook;
  };

  // --- Outbound webhooks -----------------------------------------------------------------------

  app.get(`${P}/webhooks`, requireRole('admin'), async (c) => {
    const rows = await ctx.db
      .select()
      .from(webhooks)
      .where(eq(webhooks.projectId, c.get('project').id))
      .orderBy(asc(webhooks.createdAt));
    const last = rows.length
      ? await ctx.db
          .select()
          .from(webhookDeliveries)
          .where(
            inArray(
              webhookDeliveries.webhookId,
              rows.map((r) => r.id),
            ),
          )
          .orderBy(desc(webhookDeliveries.createdAt))
      : [];
    return c.json({
      webhooks: rows.map((r) => ({
        ...view(r),
        lastDelivery: last.find((d) => d.webhookId === r.id) ?? null,
      })),
    });
  });

  app.post(`${P}/webhooks`, requireRole('admin'), async (c) => {
    const input = z
      .object({
        url: z.url(),
        events: z.array(eventPattern).min(1).max(50).default(['*']),
        description: z.string().max(200).default(''),
        enabled: z.boolean().default(true),
      })
      .parse(await c.req.json());
    checkUrl(input.url);
    const secret = newFunctionSecret();
    const [row] = await ctx.db
      .insert(webhooks)
      .values({
        id: newId('whk'),
        projectId: c.get('project').id,
        ...input,
        secret: ctx.secrets.seal(secret),
      })
      .returning();
    await audit(ctx.db, c.get('project').id, c.get('user').id, 'webhook.create', input.url, {
      events: input.events,
    });
    // The secret is shown once: store it where your endpoint verifies signatures.
    return c.json({ webhook: { ...view(row!), secret } }, 201);
  });

  app.patch(`${P}/webhooks/:id`, requireRole('admin'), async (c) => {
    const hook = await loadHook(c.get('project').id, c.req.param('id'));
    const input = z
      .object({
        url: z.url().optional(),
        events: z.array(eventPattern).min(1).max(50).optional(),
        description: z.string().max(200).optional(),
        enabled: z.boolean().optional(),
        rotateSecret: z.boolean().optional(),
      })
      .parse(await c.req.json());
    const { rotateSecret, ...rest } = input;
    if (rest.url) checkUrl(rest.url);
    const secret = rotateSecret ? newFunctionSecret() : undefined;
    const [row] = await ctx.db
      .update(webhooks)
      .set({ ...rest, ...(secret ? { secret: ctx.secrets.seal(secret) } : {}) })
      .where(eq(webhooks.id, hook.id))
      .returning();
    await audit(ctx.db, c.get('project').id, c.get('user').id, 'webhook.update', row!.url, {
      ...rest,
      rotateSecret,
    });
    return c.json({ webhook: { ...view(row!), ...(secret ? { secret } : {}) } });
  });

  app.delete(`${P}/webhooks/:id`, requireRole('admin'), async (c) => {
    const hook = await loadHook(c.get('project').id, c.req.param('id'));
    await ctx.db.delete(webhooks).where(eq(webhooks.id, hook.id));
    await audit(ctx.db, c.get('project').id, c.get('user').id, 'webhook.delete', hook.url);
    return c.json({ ok: true });
  });

  /** Sends a signed `ping` now and returns what the endpoint answered. */
  app.post(`${P}/webhooks/:id/test`, requireRole('admin'), async (c) => {
    const hook = await loadHook(c.get('project').id, c.req.param('id'));
    const payload = await ctx.webhooks.payload(c.get('project').id, c.get('user').id, 'ping', '', {
      message: 'Test delivery from Zyrox',
    });
    const result = await ctx.webhooks.attempt(hook, payload, 1, false);
    return c.json({ delivery: { id: payload.id, ...result } });
  });

  app.get(`${P}/webhooks/:id/deliveries`, requireRole('admin'), async (c) => {
    const hook = await loadHook(c.get('project').id, c.req.param('id'));
    const rows = await ctx.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, hook.id))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(50);
    return c.json({ deliveries: rows });
  });

  // --- Draft preview tokens --------------------------------------------------------------------

  /**
   * A token that makes a real app build (or an SSR "draft mode") show drafts instead of releases:
   * send it as `x-zyrox-preview` (client option `previewToken`).
   */
  app.post(`${P}/preview-tokens`, requireRole('editor'), async (c) => {
    const input = z
      .object({
        expiresInMinutes: z
          .number()
          .int()
          .min(5)
          .max(30 * 24 * 60)
          .default(24 * 60),
        documents: z.array(z.string().min(1).max(200)).max(200).optional(),
      })
      .parse(await c.req.json().catch(() => ({})));
    const issued = ctx.previewTokens.issue(c.get('project').id, input);
    await audit(ctx.db, c.get('project').id, c.get('user').id, 'preview_token.create', '', {
      expiresAt: issued.expiresAt,
      documents: input.documents ?? null,
    });
    return c.json(issued, 201);
  });

  // --- Export / import -------------------------------------------------------------------------

  /** Drafts, settings and optionally version history and releases, as one JSON file. */
  app.get(`${P}/export`, requireRole('admin'), async (c) => {
    const project = c.get('project');
    const withHistory = c.req.query('versions') === 'true';
    const envRows = await ctx.db
      .select()
      .from(environments)
      .where(eq(environments.projectId, project.id))
      .orderBy(asc(environments.createdAt));
    const docRows = await ctx.db
      .select({ document: documents, content: drafts.content })
      .from(documents)
      .leftJoin(drafts, eq(drafts.documentId, documents.id))
      .where(and(eq(documents.projectId, project.id), isNull(documents.archivedAt)))
      .orderBy(asc(documents.key));
    const versionRows = withHistory
      ? await ctx.db
          .select()
          .from(versions)
          .where(
            inArray(
              versions.documentId,
              docRows.map((d) => d.document.id),
            ),
          )
          .orderBy(asc(versions.number))
      : [];
    const numberOf = new Map(versionRows.map((v) => [v.id, v.number]));
    const releaseRows = withHistory
      ? await ctx.db
          .select({ release: releases, env: environments.key, doc: documents.key })
          .from(releases)
          .innerJoin(environments, eq(environments.id, releases.environmentId))
          .innerJoin(documents, eq(documents.id, releases.documentId))
          .where(eq(environments.projectId, project.id))
      : [];
    const fnRows = await ctx.db.select().from(functions).where(eq(functions.projectId, project.id));
    const hookRows = await ctx.db.select().from(webhooks).where(eq(webhooks.projectId, project.id));
    c.header('content-disposition', `attachment; filename="${project.slug}.zyrox.json"`);
    return c.json({
      zyrox: 'project',
      version: 1,
      exportedAt: new Date().toISOString(),
      project: { name: project.name, slug: project.slug, defaultLocale: project.defaultLocale },
      environments: envRows.map((e) => ({ key: e.key, name: e.name, ttl: e.ttl })),
      documents: docRows.map(({ document, content }) => ({
        key: document.key,
        kind: document.kind,
        title: document.title,
        description: document.description,
        draft: content,
        ...(withHistory
          ? {
              versions: versionRows
                .filter((v) => v.documentId === document.id)
                .map((v) => ({ number: v.number, message: v.message, source: v.source })),
            }
          : {}),
      })),
      // Secrets are never exported: imported functions and webhooks get new ones.
      functions: fnRows.map((f) => ({
        name: f.name,
        url: f.url,
        timeoutMs: f.timeoutMs,
        enabled: f.enabled,
      })),
      webhooks: hookRows.map((h) => ({
        url: h.url,
        events: h.events,
        description: h.description,
        enabled: h.enabled,
      })),
      releases: releaseRows
        .filter((r) => numberOf.has(r.release.defaultVersionId))
        .map((r) => ({
          environment: r.env,
          document: r.doc,
          version: numberOf.get(r.release.defaultVersionId)!,
          rules: r.release.rules
            .map(({ versionId, ...rule }) =>
              versionId
                ? numberOf.has(versionId)
                  ? { ...rule, version: numberOf.get(versionId) }
                  : null
                : rule,
            )
            .filter(Boolean),
        })),
    });
  });

  /**
   * Imports an export into this project: new documents are created; existing ones keep their
   * draft unless `overwrite`. Version history is imported for documents without versions here,
   * and releases for those versions. Functions and webhooks get new secrets (returned once).
   */
  app.post(`${P}/import`, requireRole('admin'), async (c) => {
    const project = c.get('project');
    const userId = c.get('user').id;
    const body = z
      .object({ bundle: exportSchema, overwrite: z.boolean().default(false) })
      .parse(await c.req.json());
    const { bundle } = body;
    const summary = {
      created: [] as string[],
      updated: [] as string[],
      skipped: [] as string[],
      versions: 0,
      releases: 0,
      functions: [] as { name: string; secret: string }[],
      webhooks: [] as { url: string; secret: string }[],
      problems: [] as { document: string; message: string }[],
    };
    const existing = new Map(
      (await ctx.db.select().from(documents).where(eq(documents.projectId, project.id))).map((d) => [
        d.key,
        d,
      ]),
    );
    const versionIds = new Map<string, Map<number, string>>();
    // Blocks first, so screens' versions compile against the imported blocks.
    const order: Record<DocumentKind, number> = { block: 0, strings: 1, screen: 2 };
    for (const doc of [...bundle.documents].sort((a, b) => order[a.kind] - order[b.kind])) {
      let current = existing.get(doc.key);
      if (current?.archivedAt) {
        await ctx.db.delete(documents).where(eq(documents.id, current.id));
        current = undefined;
      }
      if (current && current.kind !== doc.kind) {
        summary.problems.push({ document: doc.key, message: `Exists here as a ${current.kind}` });
        continue;
      }
      if (!current) {
        [current] = await ctx.db
          .insert(documents)
          .values({
            id: newId('doc'),
            projectId: project.id,
            key: doc.key,
            kind: doc.kind,
            title: doc.title,
            description: doc.description,
          })
          .returning();
        await ctx.db
          .insert(drafts)
          .values({ documentId: current!.id, content: (doc.draft ?? {}) as object, updatedBy: userId });
        summary.created.push(doc.key);
      } else if (body.overwrite) {
        const [draft] = await ctx.db.select().from(drafts).where(eq(drafts.documentId, current.id));
        if (draft)
          await ctx.db
            .update(drafts)
            .set({
              content: (doc.draft ?? {}) as object,
              revision: draft.revision + 1,
              updatedBy: userId,
              updatedAt: new Date(),
            })
            .where(eq(drafts.documentId, current.id));
        else
          await ctx.db
            .insert(drafts)
            .values({ documentId: current.id, content: (doc.draft ?? {}) as object, updatedBy: userId });
        await ctx.db
          .update(documents)
          .set({ title: doc.title, description: doc.description })
          .where(eq(documents.id, current.id));
        summary.updated.push(doc.key);
      } else summary.skipped.push(doc.key);

      if (!doc.versions?.length) continue;
      const [hasVersions] = await ctx.db
        .select({ id: versions.id })
        .from(versions)
        .where(eq(versions.documentId, current!.id))
        .limit(1);
      if (hasVersions) continue;
      const ids = new Map<number, string>();
      for (const v of [...doc.versions].sort((a, b) => a.number - b.number)) {
        const compiled = await compileDraft(ctx.db, project.id, doc.kind, v.source);
        if (!compiled.ref) {
          summary.problems.push({ document: doc.key, message: `Version ${v.number} is invalid` });
          continue;
        }
        const id = newId('ver');
        await ctx.db.insert(versions).values({
          id,
          documentId: current!.id,
          number: v.number,
          ref: compiled.ref,
          content: compiled.content as object,
          source: v.source as object,
          message: v.message,
          createdBy: userId,
        });
        ids.set(v.number, id);
        summary.versions++;
      }
      versionIds.set(doc.key, ids);
    }

    const envs = new Map(
      (await ctx.db.select().from(environments).where(eq(environments.projectId, project.id))).map((e) => [
        e.key,
        e,
      ]),
    );
    for (const env of bundle.environments) {
      const target = envs.get(env.key);
      if (target && env.ttl !== undefined)
        await ctx.db.update(environments).set({ ttl: env.ttl }).where(eq(environments.id, target.id));
    }
    const docIds = new Map(
      (await ctx.db.select().from(documents).where(eq(documents.projectId, project.id))).map((d) => [
        d.key,
        d.id,
      ]),
    );
    for (const release of bundle.releases) {
      const env = envs.get(release.environment);
      const ids = versionIds.get(release.document);
      const versionId = ids?.get(release.version);
      const documentId = docIds.get(release.document);
      if (!env || !versionId || !documentId) continue;
      const rules = release.rules.flatMap((rule) => {
        const { version, ...rest } = rule as unknown as ReleaseRule & { version?: number };
        if (version === undefined) return [rest as ReleaseRule];
        const mapped = ids?.get(version);
        return mapped ? [{ ...rest, versionId: mapped } as ReleaseRule] : [];
      });
      await ctx.db
        .insert(releases)
        .values({
          id: newId('rel'),
          environmentId: env.id,
          documentId,
          defaultVersionId: versionId,
          rules,
          updatedBy: userId,
        })
        .onConflictDoUpdate({
          target: [releases.environmentId, releases.documentId],
          set: { defaultVersionId: versionId, rules, updatedBy: userId, updatedAt: new Date() },
        });
      summary.releases++;
    }

    const fnNames = new Set(
      (
        await ctx.db
          .select({ name: functions.name })
          .from(functions)
          .where(eq(functions.projectId, project.id))
      ).map((f) => f.name),
    );
    for (const fn of bundle.functions) {
      if (fnNames.has(fn.name) || ctx.options.functions?.[fn.name]) continue;
      try {
        assertCallableUrl(fn.url, Boolean(ctx.options.allowPrivateUrls));
      } catch (err) {
        summary.problems.push({ document: `function ${fn.name}`, message: (err as Error).message });
        continue;
      }
      const secret = newFunctionSecret();
      await ctx.db
        .insert(functions)
        .values({ id: newId('fn'), projectId: project.id, ...fn, secret: ctx.secrets.seal(secret) });
      summary.functions.push({ name: fn.name, secret });
    }
    const hookUrls = new Set(
      (
        await ctx.db.select({ url: webhooks.url }).from(webhooks).where(eq(webhooks.projectId, project.id))
      ).map((h) => h.url),
    );
    for (const hook of bundle.webhooks) {
      if (hookUrls.has(hook.url)) continue;
      hook.events = hook.events.filter((e) => eventPattern.safeParse(e).success);
      if (!hook.events.length) hook.events = ['*'];
      try {
        assertCallableUrl(hook.url, Boolean(ctx.options.allowPrivateUrls));
      } catch (err) {
        summary.problems.push({ document: `webhook ${hook.url}`, message: (err as Error).message });
        continue;
      }
      const secret = newFunctionSecret();
      await ctx.db
        .insert(webhooks)
        .values({ id: newId('whk'), projectId: project.id, ...hook, secret: ctx.secrets.seal(secret) });
      summary.webhooks.push({ url: hook.url, secret });
    }
    ctx.delivery.invalidate();
    await audit(ctx.db, project.id, userId, 'project.import', project.slug, {
      created: summary.created.length,
      updated: summary.updated.length,
      versions: summary.versions,
      releases: summary.releases,
    });
    return c.json(summary);
  });

  return app;
}
