import { parseExpression } from '@zyrox/core';
import { z } from '@zyrox/protocol';
import { and, desc, eq, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { requireRole } from '../auth';
import type { AppEnv, ServerContext } from '../context';
import { newId } from '../crypto';
import type { Db } from '../db';
import { documents, environments, experiments, type ReleaseRule, releases, versions } from '../db/schema';
import { fail, notFound } from '../errors';
import { audit } from '../services/audit';

async function environmentByKey(db: Db, projectId: string, key: string) {
  const [env] = await db
    .select()
    .from(environments)
    .where(and(eq(environments.projectId, projectId), eq(environments.key, key)));
  if (!env) notFound(`Environment "${key}"`);
  return env;
}

async function documentByKey(db: Db, projectId: string, key: string) {
  const [doc] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.projectId, projectId), eq(documents.key, key)));
  if (!doc) notFound(`Document "${key}"`);
  return doc;
}

async function versionByNumber(db: Db, documentId: string, number: number) {
  const [v] = await db
    .select()
    .from(versions)
    .where(and(eq(versions.documentId, documentId), eq(versions.number, number)));
  if (!v) notFound(`Version ${number}`);
  return v;
}

const ruleInput = z.object({
  id: z.string().optional(),
  name: z.string().max(100).optional(),
  when: z.string().max(1000).optional(),
  rollout: z.number().min(0).max(100).optional(),
  version: z.number().int().optional(),
  experiment: z.string().optional(),
});

export function releaseRoutes(ctx: ServerContext) {
  const app = new Hono<AppEnv>();
  const E = '/projects/:project/environments/:env';

  app.get(`${E}/releases`, async (c) => {
    const env = await environmentByKey(ctx.db, c.get('project').id, c.req.param('env'));
    const rows = await ctx.db
      .select({
        release: releases,
        key: documents.key,
        kind: documents.kind,
        number: versions.number,
        ref: versions.ref,
      })
      .from(releases)
      .innerJoin(documents, eq(documents.id, releases.documentId))
      .innerJoin(versions, eq(versions.id, releases.defaultVersionId))
      .where(eq(releases.environmentId, env.id))
      .orderBy(documents.key);
    const versionNumbers = new Map(
      (
        await ctx.db
          .select({ id: versions.id, number: versions.number })
          .from(versions)
          .innerJoin(documents, eq(documents.id, versions.documentId))
          .where(eq(documents.projectId, c.get('project').id))
      ).map((v) => [v.id, v.number]),
    );
    const experimentKeys = new Map(
      (
        await ctx.db
          .select()
          .from(experiments)
          .where(eq(experiments.projectId, c.get('project').id))
      ).map((e) => [e.id, e.key]),
    );
    return c.json({
      environment: env,
      releases: rows.map((r) => ({
        document: r.key,
        kind: r.kind,
        version: r.number,
        ref: r.ref,
        updatedAt: r.release.updatedAt,
        rules: r.release.rules.map((rule) => ({
          id: rule.id,
          name: rule.name,
          when: rule.when,
          rollout: rule.rollout,
          version: rule.versionId ? versionNumbers.get(rule.versionId) : undefined,
          experiment: rule.experimentId ? experimentKeys.get(rule.experimentId) : undefined,
        })),
      })),
    });
  });

  app.put(`${E}/releases/:key{.+}`, requireRole('publisher'), async (c) => {
    const project = c.get('project');
    const env = await environmentByKey(ctx.db, project.id, c.req.param('env'));
    const doc = await documentByKey(ctx.db, project.id, c.req.param('key'));
    if (doc.kind === 'block')
      fail(400, 'Blocks are included in screens when published; they are not released', 'invalid');
    const input = z
      .object({ version: z.number().int(), rules: z.array(ruleInput).max(50).default([]) })
      .parse(await c.req.json());
    const defaultVersion = await versionByNumber(ctx.db, doc.id, input.version);
    const rules: ReleaseRule[] = [];
    for (const rule of input.rules) {
      if (rule.when?.trim()) {
        try {
          parseExpression(rule.when);
        } catch (err) {
          fail(400, `Rule "${rule.name ?? rule.when}": ${(err as Error).message}`, 'invalid');
        }
      }
      const out: ReleaseRule = {
        id: rule.id ?? newId('rule', 6),
        name: rule.name,
        when: rule.when?.trim() || undefined,
        rollout: rule.rollout,
      };
      if (rule.experiment) {
        const [experiment] = await ctx.db
          .select()
          .from(experiments)
          .where(and(eq(experiments.projectId, project.id), eq(experiments.key, rule.experiment)));
        if (!experiment) notFound(`Experiment "${rule.experiment}"`);
        if (experiment.documentId !== doc.id)
          fail(400, `Experiment "${rule.experiment}" is for another document`, 'invalid');
        out.experimentId = experiment.id;
      } else if (rule.version !== undefined) {
        out.versionId = (await versionByNumber(ctx.db, doc.id, rule.version)).id;
      } else {
        fail(400, 'Each rule needs a version or an experiment', 'invalid');
      }
      rules.push(out);
    }
    await ctx.db
      .insert(releases)
      .values({
        id: newId('rel'),
        environmentId: env.id,
        documentId: doc.id,
        defaultVersionId: defaultVersion.id,
        rules,
        updatedBy: c.get('user').id,
      })
      .onConflictDoUpdate({
        target: [releases.environmentId, releases.documentId],
        set: {
          defaultVersionId: defaultVersion.id,
          rules,
          updatedBy: c.get('user').id,
          updatedAt: new Date(),
        },
      });
    ctx.delivery.invalidate();
    await audit(ctx.db, project.id, c.get('user').id, 'release.set', `${env.key}:${doc.key}`, {
      version: input.version,
      rules: input.rules,
    });
    return c.json({ ok: true });
  });

  app.post(`${E}/releases/:key{.+}/rollback`, requireRole('publisher'), async (c) => {
    const project = c.get('project');
    const env = await environmentByKey(ctx.db, project.id, c.req.param('env'));
    const doc = await documentByKey(ctx.db, project.id, c.req.param('key'));
    const [release] = await ctx.db
      .select({ release: releases, number: versions.number })
      .from(releases)
      .innerJoin(versions, eq(versions.id, releases.defaultVersionId))
      .where(and(eq(releases.environmentId, env.id), eq(releases.documentId, doc.id)));
    if (!release) notFound('Release');
    const [previous] = await ctx.db
      .select()
      .from(versions)
      .where(and(eq(versions.documentId, doc.id), lt(versions.number, release.number)))
      .orderBy(desc(versions.number))
      .limit(1);
    if (!previous) fail(400, 'There is no earlier version to roll back to', 'invalid');
    // Rolling back also clears targeting rules, so everyone gets the previous version.
    await ctx.db
      .update(releases)
      .set({ defaultVersionId: previous.id, rules: [], updatedBy: c.get('user').id, updatedAt: new Date() })
      .where(eq(releases.id, release.release.id));
    ctx.delivery.invalidate();
    await audit(ctx.db, project.id, c.get('user').id, 'release.rollback', `${env.key}:${doc.key}`, {
      from: release.number,
      to: previous.number,
    });
    return c.json({ version: previous.number });
  });

  app.delete(`${E}/releases/:key{.+}`, requireRole('publisher'), async (c) => {
    const project = c.get('project');
    const env = await environmentByKey(ctx.db, project.id, c.req.param('env'));
    const doc = await documentByKey(ctx.db, project.id, c.req.param('key'));
    await ctx.db
      .delete(releases)
      .where(and(eq(releases.environmentId, env.id), eq(releases.documentId, doc.id)));
    ctx.delivery.invalidate();
    await audit(ctx.db, project.id, c.get('user').id, 'release.remove', `${env.key}:${doc.key}`);
    return c.json({ ok: true });
  });

  app.post('/projects/:project/promote', requireRole('publisher'), async (c) => {
    const project = c.get('project');
    const input = z
      .object({ from: z.string(), to: z.string(), documents: z.array(z.string()).optional() })
      .parse(await c.req.json());
    const from = await environmentByKey(ctx.db, project.id, input.from);
    const to = await environmentByKey(ctx.db, project.id, input.to);
    const rows = await ctx.db
      .select({ release: releases, key: documents.key })
      .from(releases)
      .innerJoin(documents, eq(documents.id, releases.documentId))
      .where(eq(releases.environmentId, from.id));
    const selected = rows.filter((r) => !input.documents || input.documents.includes(r.key));
    for (const { release } of selected) {
      await ctx.db
        .insert(releases)
        .values({
          id: newId('rel'),
          environmentId: to.id,
          documentId: release.documentId,
          defaultVersionId: release.defaultVersionId,
          rules: release.rules,
          updatedBy: c.get('user').id,
        })
        .onConflictDoUpdate({
          target: [releases.environmentId, releases.documentId],
          set: {
            defaultVersionId: release.defaultVersionId,
            rules: release.rules,
            updatedBy: c.get('user').id,
            updatedAt: new Date(),
          },
        });
    }
    ctx.delivery.invalidate();
    await audit(ctx.db, project.id, c.get('user').id, 'release.promote', `${from.key}→${to.key}`, {
      documents: selected.map((r) => r.key),
    });
    return c.json({ promoted: selected.map((r) => r.key) });
  });

  // --- Experiments -----------------------------------------------------------------------------

  const variantsInput = z
    .array(
      z.object({
        key: z.string().min(1).max(50),
        version: z.number().int(),
        weight: z.number().min(0).max(100),
      }),
    )
    .min(2)
    .max(10);

  const experimentView = async (row: typeof experiments.$inferSelect) => {
    const [doc] = await ctx.db.select().from(documents).where(eq(documents.id, row.documentId));
    const numbers = new Map(
      (
        await ctx.db
          .select({ id: versions.id, number: versions.number })
          .from(versions)
          .where(eq(versions.documentId, row.documentId))
      ).map((v) => [v.id, v.number]),
    );
    return {
      key: row.key,
      name: row.name,
      status: row.status,
      document: doc?.key,
      createdAt: row.createdAt,
      variants: row.variants.map((v) => ({
        key: v.key,
        weight: v.weight,
        version: numbers.get(v.versionId),
      })),
    };
  };

  app.get('/projects/:project/experiments', async (c) => {
    const rows = await ctx.db
      .select()
      .from(experiments)
      .where(eq(experiments.projectId, c.get('project').id))
      .orderBy(desc(experiments.createdAt));
    return c.json({ experiments: await Promise.all(rows.map(experimentView)) });
  });

  app.post('/projects/:project/experiments', requireRole('publisher'), async (c) => {
    const project = c.get('project');
    const input = z
      .object({
        key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i),
        name: z.string().max(200).default(''),
        document: z.string(),
        variants: variantsInput,
      })
      .parse(await c.req.json());
    const doc = await documentByKey(ctx.db, project.id, input.document);
    const variants = [];
    for (const v of input.variants)
      variants.push({
        key: v.key,
        weight: v.weight,
        versionId: (await versionByNumber(ctx.db, doc.id, v.version)).id,
      });
    const [row] = await ctx.db
      .insert(experiments)
      .values({
        id: newId('exp'),
        projectId: project.id,
        documentId: doc.id,
        key: input.key,
        name: input.name,
        variants,
      })
      .returning();
    await audit(ctx.db, project.id, c.get('user').id, 'experiment.create', input.key);
    return c.json({ experiment: await experimentView(row!) }, 201);
  });

  app.patch('/projects/:project/experiments/:key', requireRole('publisher'), async (c) => {
    const project = c.get('project');
    const input = z
      .object({
        name: z.string().max(200).optional(),
        status: z.enum(['draft', 'running', 'stopped']).optional(),
        variants: variantsInput.optional(),
      })
      .parse(await c.req.json());
    const [existing] = await ctx.db
      .select()
      .from(experiments)
      .where(and(eq(experiments.projectId, project.id), eq(experiments.key, c.req.param('key'))));
    if (!existing) notFound('Experiment');
    const set: Partial<typeof experiments.$inferInsert> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.status) set.status = input.status;
    if (input.variants) {
      set.variants = [];
      for (const v of input.variants)
        set.variants.push({
          key: v.key,
          weight: v.weight,
          versionId: (await versionByNumber(ctx.db, existing.documentId, v.version)).id,
        });
    }
    const [row] = await ctx.db
      .update(experiments)
      .set(set)
      .where(eq(experiments.id, existing.id))
      .returning();
    ctx.delivery.invalidate();
    await audit(ctx.db, project.id, c.get('user').id, 'experiment.update', existing.key, input);
    return c.json({ experiment: await experimentView(row!) });
  });

  return app;
}
