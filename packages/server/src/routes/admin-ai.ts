import type { Document } from '@zyrox/protocol';
import { z } from '@zyrox/protocol';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { requireRole } from '../auth';
import type { AppEnv, ServerContext } from '../context';
import { documents } from '../db/schema';
import { fail, notFound } from '../errors';
import { type AssistantEvent, runAssistant } from '../services/ai';
import { audit } from '../services/audit';
import { latestManifest } from '../services/publish';
import { translateChecked } from '../services/translation';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function aiRoutes(ctx: ServerContext) {
  const app = new Hono<AppEnv>();
  const requireAi = () => {
    if (!ctx.ai)
      fail(503, 'The AI assistant is not configured on this server (set ANTHROPIC_API_KEY).', 'ai_disabled');
    return ctx.ai;
  };

  app.get('/ai/status', (c) =>
    c.json({
      enabled: Boolean(ctx.ai),
      model: ctx.ai?.model ?? null,
      translation: ctx.translation
        ? { provider: ctx.translation.provider.name, runtime: Boolean(ctx.translation.runtime) }
        : null,
    }),
  );

  app.post('/projects/:project/documents/:key{.+}/ai', requireRole('editor'), async (c) => {
    const ai = requireAi();
    const project = c.get('project');
    const [doc] = await ctx.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.projectId, project.id),
          eq(documents.key, c.req.param('key')),
          isNull(documents.archivedAt),
        ),
      );
    if (!doc) notFound('Document');
    if (doc.kind === 'strings') fail(400, 'Use translation for strings documents', 'invalid');
    const body = z
      .object({
        prompt: z.string().min(1).max(4000),
        document: z.record(z.string(), z.unknown()),
        image: z
          .object({
            mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
            data: z.string().max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3)),
          })
          .optional(),
      })
      .parse(await c.req.json());
    const manifest = (await latestManifest(ctx.db, project.id))?.manifest;
    await audit(ctx.db, project.id, c.get('user').id, 'ai.edit', doc.key, {
      prompt: body.prompt.slice(0, 200),
      image: Boolean(body.image),
    });
    c.header('content-type', 'application/x-ndjson');
    c.header('cache-control', 'no-store');
    return stream(c, async (out) => {
      const controller = new AbortController();
      out.onAbort(() => controller.abort());
      const send = (event: AssistantEvent) => out.write(`${JSON.stringify(event)}\n`);
      try {
        await runAssistant({
          client: ai.client,
          model: ai.model,
          effort: ai.effort,
          manifest,
          document: body.document as unknown as Document,
          prompt: body.prompt,
          image: body.image,
          signal: controller.signal,
          onEvent: (event) => void send(event),
        });
      } catch (err) {
        await send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    });
  });

  app.post('/projects/:project/translate', requireRole('editor'), async (c) => {
    const translation = ctx.translation;
    if (!translation)
      fail(
        503,
        'No translation provider is configured (set ANTHROPIC_API_KEY or ZYROX_TRANSLATOR).',
        'translation_disabled',
      );
    const body = z
      .object({
        locale: z.string().min(2).max(20),
        sourceLocale: z.string().min(2).max(20),
        messages: z
          .record(z.string(), z.string())
          .refine((m) => Object.keys(m).length <= 500, 'At most 500 keys at a time'),
      })
      .parse(await c.req.json());
    const translated = await translateChecked(translation.provider, {
      locale: body.locale,
      sourceLocale: body.sourceLocale,
      messages: body.messages,
      context: c.get('project').name,
    });
    await audit(ctx.db, c.get('project').id, c.get('user').id, 'translate', body.locale, {
      provider: translation.provider.name,
      keys: Object.keys(translated).length,
    });
    return c.json({ messages: translated, provider: translation.provider.name });
  });

  return app;
}
