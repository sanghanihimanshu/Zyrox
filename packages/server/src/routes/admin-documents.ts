import { applyOps, OpError } from '@wishyor/zyrox-core';
import { canonicalJson, type Document, type Manifest, opSchema, z } from '@wishyor/zyrox-protocol';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { requireRole } from '../auth';
import type { AppEnv, ServerContext } from '../context';
import { newId } from '../crypto';
import type { Db } from '../db';
import { type DocumentKind, documents, drafts, environments, releases, users, versions } from '../db/schema';
import { fail, notFound } from '../errors';
import { audit } from '../services/audit';
import { compileDraft, latestManifest } from '../services/publish';

const MAX_DRAFT_BYTES = 1_000_000;
const keyPattern = /^[a-z0-9][a-z0-9._/-]{0,99}$/i;
const localePattern = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export function template(kind: DocumentKind, key: string, title: string, manifest?: Manifest): unknown {
  if (kind === 'strings')
    return { zyrox: 1, kind: 'strings', locale: key.slice('strings/'.length), messages: {} };
  const container =
    Object.entries(manifest?.components ?? {}).find(
      ([name, c]) => c.children && /screen|page|layout/i.test(name),
    )?.[0] ??
    Object.entries(manifest?.components ?? {}).find(([, c]) => c.children)?.[0] ??
    'Screen';
  return {
    zyrox: 1,
    kind,
    key,
    ...(title ? { title } : {}),
    root: { id: 'root', type: container, children: [] },
  };
}

async function loadDocument(db: Db, projectId: string, key: string) {
  const [row] = await db
    .select({ document: documents, draft: drafts })
    .from(documents)
    .leftJoin(drafts, eq(drafts.documentId, documents.id))
    .where(and(eq(documents.projectId, projectId), eq(documents.key, key), isNull(documents.archivedAt)));
  if (!row) notFound(`Document "${key}"`);
  return row;
}

async function latestVersion(db: Db, documentId: string) {
  const [row] = await db
    .select()
    .from(versions)
    .where(eq(versions.documentId, documentId))
    .orderBy(desc(versions.number))
    .limit(1);
  return row;
}

/** Releases a version as the default of each environment, keeping existing rules. */
export async function releaseVersion(
  db: Db,
  projectId: string,
  documentId: string,
  versionId: string,
  envKeys: string[],
  userId: string | null,
) {
  if (!envKeys.length) return;
  const envs = await db
    .select()
    .from(environments)
    .where(and(eq(environments.projectId, projectId), inArray(environments.key, envKeys)));
  for (const env of envs) {
    await db
      .insert(releases)
      .values({
        id: newId('rel'),
        environmentId: env.id,
        documentId,
        defaultVersionId: versionId,
        updatedBy: userId,
      })
      .onConflictDoUpdate({
        target: [releases.environmentId, releases.documentId],
        set: { defaultVersionId: versionId, updatedBy: userId, updatedAt: new Date() },
      });
  }
}

export function documentRoutes(ctx: ServerContext) {
  const app = new Hono<AppEnv>();
  const P = '/projects/:project/documents';

  app.get(P, async (c) => {
    const project = c.get('project');
    const kind = c.req.query('kind') as DocumentKind | undefined;
    const rows = await ctx.db
      .select({
        document: documents,
        revision: drafts.revision,
        updatedAt: drafts.updatedAt,
        content: drafts.content,
      })
      .from(documents)
      .leftJoin(drafts, eq(drafts.documentId, documents.id))
      .where(
        and(
          eq(documents.projectId, project.id),
          isNull(documents.archivedAt),
          kind ? eq(documents.kind, kind) : undefined,
        ),
      )
      .orderBy(documents.key);
    const ids = rows.map((r) => r.document.id);
    const latest = ids.length
      ? await ctx.db
          .selectDistinctOn([versions.documentId], {
            documentId: versions.documentId,
            number: versions.number,
            ref: versions.ref,
            source: versions.source,
            createdAt: versions.createdAt,
          })
          .from(versions)
          .where(inArray(versions.documentId, ids))
          .orderBy(versions.documentId, desc(versions.number))
      : [];
    const live = ids.length
      ? await ctx.db
          .select({
            documentId: releases.documentId,
            env: environments.key,
            number: versions.number,
            rules: releases.rules,
          })
          .from(releases)
          .innerJoin(environments, eq(environments.id, releases.environmentId))
          .innerJoin(versions, eq(versions.id, releases.defaultVersionId))
          .where(inArray(releases.documentId, ids))
      : [];
    const latestBy = new Map(latest.map((l) => [l.documentId, l]));
    return c.json({
      documents: rows.map(({ document, revision, updatedAt, content }) => {
        const l = latestBy.get(document.id);
        return {
          ...document,
          revision,
          updatedAt,
          latest: l ? { number: l.number, ref: l.ref, createdAt: l.createdAt } : null,
          dirty: !l || canonicalJson(l.source) !== canonicalJson(content),
          live: Object.fromEntries(
            live
              .filter((r) => r.documentId === document.id)
              .map((r) => [r.env, { number: r.number, rules: r.rules.length }]),
          ),
        };
      }),
    });
  });

  app.post(P, requireRole('editor'), async (c) => {
    const project = c.get('project');
    const input = z
      .object({
        key: z.string().regex(keyPattern, 'Use letters, digits, ".", "_", "/" and "-"'),
        kind: z.enum(['screen', 'block', 'strings']),
        title: z.string().max(200).default(''),
        description: z.string().max(1000).default(''),
        content: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(await c.req.json());
    if (
      input.kind === 'strings' &&
      !(input.key.startsWith('strings/') && localePattern.test(input.key.slice(8)))
    ) {
      fail(400, 'Translation documents are named "strings/<locale>", e.g. "strings/fr"', 'invalid');
    }
    if (input.kind !== 'strings' && input.key.startsWith('strings/'))
      fail(400, '"strings/" is reserved for translations', 'invalid');
    const [existing] = await ctx.db
      .select()
      .from(documents)
      .where(and(eq(documents.projectId, project.id), eq(documents.key, input.key)));
    if (existing && !existing.archivedAt) fail(409, `"${input.key}" already exists`, 'conflict');
    if (existing) await ctx.db.delete(documents).where(eq(documents.id, existing.id));
    const manifest = await latestManifest(ctx.db, project.id);
    const content = input.content
      ? { ...input.content, key: input.kind === 'strings' ? undefined : input.key }
      : template(input.kind, input.key, input.title, manifest?.manifest);
    const [document] = await ctx.db
      .insert(documents)
      .values({
        id: newId('doc'),
        projectId: project.id,
        key: input.key,
        kind: input.kind,
        title: input.title,
        description: input.description,
      })
      .returning();
    const [draft] = await ctx.db
      .insert(drafts)
      .values({
        documentId: document!.id,
        content: JSON.parse(JSON.stringify(content)),
        updatedBy: c.get('user').id,
      })
      .returning();
    await audit(ctx.db, project.id, c.get('user').id, 'document.create', input.key, { kind: input.kind });
    return c.json({ document, draft: { content: draft!.content, revision: draft!.revision } }, 201);
  });

  app.get(`${P}/:key{.+}/versions/:number`, async (c) => {
    const { document } = await loadDocument(ctx.db, c.get('project').id, c.req.param('key'));
    const [version] = await ctx.db
      .select()
      .from(versions)
      .where(and(eq(versions.documentId, document.id), eq(versions.number, Number(c.req.param('number')))));
    if (!version) notFound('Version');
    return c.json({ version });
  });

  app.post(`${P}/:key{.+}/versions/:number/restore`, requireRole('editor'), async (c) => {
    const { document, draft } = await loadDocument(ctx.db, c.get('project').id, c.req.param('key'));
    const [version] = await ctx.db
      .select()
      .from(versions)
      .where(and(eq(versions.documentId, document.id), eq(versions.number, Number(c.req.param('number')))));
    if (!version) notFound('Version');
    const [updated] = await ctx.db
      .update(drafts)
      .set({
        content: version.source,
        revision: (draft?.revision ?? 0) + 1,
        updatedBy: c.get('user').id,
        updatedAt: new Date(),
      })
      .where(eq(drafts.documentId, document.id))
      .returning();
    await audit(ctx.db, c.get('project').id, c.get('user').id, 'document.restore', document.key, {
      number: version.number,
    });
    return c.json({ draft: { content: updated!.content, revision: updated!.revision } });
  });

  app.get(`${P}/:key{.+}/versions`, async (c) => {
    const { document } = await loadDocument(ctx.db, c.get('project').id, c.req.param('key'));
    const rows = await ctx.db
      .select({
        id: versions.id,
        number: versions.number,
        ref: versions.ref,
        message: versions.message,
        createdAt: versions.createdAt,
        author: users.name,
      })
      .from(versions)
      .leftJoin(users, eq(users.id, versions.createdBy))
      .where(eq(versions.documentId, document.id))
      .orderBy(desc(versions.number));
    return c.json({ versions: rows });
  });

  app.put(`${P}/:key{.+}/draft`, requireRole('editor'), async (c) => {
    const { document } = await loadDocument(ctx.db, c.get('project').id, c.req.param('key'));
    const body = (await c.req.json()) as { content?: unknown; revision?: number };
    if (!body.content || typeof body.content !== 'object' || Array.isArray(body.content))
      fail(400, 'content must be an object', 'invalid');
    if (JSON.stringify(body.content).length > MAX_DRAFT_BYTES)
      fail(413, 'Document is too large', 'too_large');
    const [updated] = await ctx.db
      .update(drafts)
      .set({
        content: body.content,
        revision: sql`${drafts.revision} + 1`,
        updatedBy: c.get('user').id,
        updatedAt: new Date(),
      })
      .where(and(eq(drafts.documentId, document.id), eq(drafts.revision, Number(body.revision))))
      .returning();
    if (!updated) {
      const [current] = await ctx.db.select().from(drafts).where(eq(drafts.documentId, document.id));
      fail(409, 'Someone else changed this document. Reload to continue.', 'conflict', {
        revision: current?.revision,
        content: current?.content,
      });
    }
    return c.json({ draft: { content: updated.content, revision: updated.revision } });
  });

  app.post(`${P}/:key{.+}/ops`, requireRole('editor'), async (c) => {
    const { document, draft } = await loadDocument(ctx.db, c.get('project').id, c.req.param('key'));
    if (document.kind === 'strings') fail(400, 'Use PUT …/draft for translations', 'invalid');
    const body = z
      .object({ ops: z.array(opSchema).min(1).max(500), revision: z.number().int().optional() })
      .parse(await c.req.json());
    if (!draft) notFound('Draft');
    if (body.revision !== undefined && body.revision !== draft.revision) {
      fail(409, 'Someone else changed this document. Reload to continue.', 'conflict', {
        revision: draft.revision,
        content: draft.content,
      });
    }
    let result: ReturnType<typeof applyOps>;
    try {
      result = applyOps(draft.content as Document, body.ops);
    } catch (err) {
      if (err instanceof OpError) fail(422, err.message, 'invalid_op');
      throw err;
    }
    const [updated] = await ctx.db
      .update(drafts)
      .set({
        content: result.doc,
        revision: draft.revision + 1,
        updatedBy: c.get('user').id,
        updatedAt: new Date(),
      })
      .where(and(eq(drafts.documentId, document.id), eq(drafts.revision, draft.revision)))
      .returning();
    if (!updated) fail(409, 'Someone else changed this document. Reload to continue.', 'conflict');
    return c.json({
      draft: { content: updated.content, revision: updated.revision },
      inverse: result.inverse,
    });
  });

  app.post(`${P}/:key{.+}/validate`, async (c) => {
    const { document, draft } = await loadDocument(ctx.db, c.get('project').id, c.req.param('key'));
    const body = (await c.req.json().catch(() => ({}))) as { content?: unknown };
    const result = await compileDraft(
      ctx.db,
      c.get('project').id,
      document.kind,
      body.content ?? draft?.content,
    );
    return c.json({
      problems: result.problems,
      compat: result.compat,
      ref: result.ref,
      blocks: result.blocks,
      manifest: result.manifest,
    });
  });

  app.post(`${P}/:key{.+}/publish`, requireRole('publisher'), async (c) => {
    const project = c.get('project');
    const { document, draft } = await loadDocument(ctx.db, project.id, c.req.param('key'));
    const body = z
      .object({
        message: z.string().max(500).default(''),
        release: z.array(z.string()).default([]),
        revision: z.number().int().optional(),
      })
      .parse(await c.req.json().catch(() => ({})));
    if (!draft) notFound('Draft');
    if (body.revision !== undefined && body.revision !== draft.revision)
      fail(409, 'The draft changed since you reviewed it', 'conflict');
    const result = await compileDraft(ctx.db, project.id, document.kind, draft.content);
    const errors = result.problems.filter((p) => p.level === 'error');
    if (errors.length)
      fail(
        422,
        `Fix ${errors.length} problem${errors.length === 1 ? '' : 's'} before publishing`,
        'invalid_document',
        result,
      );
    const previous = await latestVersion(ctx.db, document.id);
    let version = previous;
    if (
      !previous ||
      previous.ref !== result.ref ||
      canonicalJson(previous.source) !== canonicalJson(draft.content)
    ) {
      [version] = await ctx.db
        .insert(versions)
        .values({
          id: newId('ver'),
          documentId: document.id,
          number: (previous?.number ?? 0) + 1,
          ref: result.ref,
          content: result.content as object,
          source: draft.content as object,
          message: body.message,
          createdBy: c.get('user').id,
        })
        .returning();
    }
    await releaseVersion(ctx.db, project.id, document.id, version!.id, body.release, c.get('user').id);
    ctx.delivery.invalidate();
    await audit(ctx.db, project.id, c.get('user').id, 'document.publish', document.key, {
      number: version!.number,
      ref: version!.ref,
      release: body.release,
    });
    return c.json({
      version: { id: version!.id, number: version!.number, ref: version!.ref, createdAt: version!.createdAt },
      problems: result.problems,
      compat: result.compat,
    });
  });

  app.get(`${P}/:key{.+}`, async (c) => {
    const { document, draft } = await loadDocument(ctx.db, c.get('project').id, c.req.param('key'));
    const latest = await latestVersion(ctx.db, document.id);
    return c.json({
      document,
      draft: draft ? { content: draft.content, revision: draft.revision, updatedAt: draft.updatedAt } : null,
      latest: latest ? { number: latest.number, ref: latest.ref, createdAt: latest.createdAt } : null,
      dirty: !latest || canonicalJson(latest.source) !== canonicalJson(draft?.content),
    });
  });

  app.patch(`${P}/:key{.+}`, requireRole('editor'), async (c) => {
    const { document } = await loadDocument(ctx.db, c.get('project').id, c.req.param('key'));
    const input = z
      .object({ title: z.string().max(200).optional(), description: z.string().max(1000).optional() })
      .parse(await c.req.json());
    const [updated] = await ctx.db
      .update(documents)
      .set(input)
      .where(eq(documents.id, document.id))
      .returning();
    return c.json({ document: updated });
  });

  app.delete(`${P}/:key{.+}`, requireRole('admin'), async (c) => {
    const { document } = await loadDocument(ctx.db, c.get('project').id, c.req.param('key'));
    await ctx.db.delete(releases).where(eq(releases.documentId, document.id));
    await ctx.db.update(documents).set({ archivedAt: new Date() }).where(eq(documents.id, document.id));
    ctx.delivery.invalidate();
    await audit(ctx.db, c.get('project').id, c.get('user').id, 'document.archive', document.key);
    return c.json({ ok: true });
  });

  return app;
}
