import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { type Document, documentSchema } from '@wishyor/zyrox-protocol';
import { and, eq, isNull } from 'drizzle-orm';
import type { ServerContext } from '../context';
import { documents, drafts } from '../db/schema';
import { expandBlocks } from './blocks';
import { contentRef } from './publish';

/** What a draft preview token allows: one project's drafts, until it expires. */
export interface PreviewClaims {
  /** Project id. */
  p: string;
  /** Expiry, epoch seconds. */
  e: number;
  /** Only these document keys show their drafts (default: all). */
  d?: string[];
}

const PREFIX = 'zpv_';

/**
 * Stateless, signed tokens for draft previews in real app builds and SSR "draft mode". Signed
 * with the server secret key: rotating `ZYROX_SECRET_KEY` revokes every token. Without a
 * secret key, tokens only last until the server restarts.
 */
export class PreviewTokens {
  private readonly key: Buffer;

  constructor(secretKey: string | undefined) {
    this.key = secretKey
      ? createHmac('sha256', 'zyrox-preview-tokens').update(secretKey).digest()
      : randomBytes(32);
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.key).update(payload).digest('base64url');
  }

  issue(
    projectId: string,
    options: { expiresInMinutes: number; documents?: string[] },
  ): {
    token: string;
    expiresAt: string;
  } {
    const exp = Math.floor(Date.now() / 1000) + Math.round(options.expiresInMinutes * 60);
    const claims: PreviewClaims = {
      p: projectId,
      e: exp,
      ...(options.documents?.length ? { d: options.documents } : {}),
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return {
      token: `${PREFIX}${payload}.${this.sign(payload)}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  verify(token: string | undefined): PreviewClaims | undefined {
    if (!token?.startsWith(PREFIX) || token.length > 4096) return undefined;
    const [payload, signature] = token.slice(PREFIX.length).split('.');
    if (!payload || !signature) return undefined;
    const expected = Buffer.from(this.sign(payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PreviewClaims;
      if (typeof claims.p !== 'string' || typeof claims.e !== 'number' || claims.e * 1000 < Date.now())
        return undefined;
      return claims;
    } catch {
      return undefined;
    }
  }
}

/**
 * The drafts of a project's screens as clients would receive them (blocks expanded from their
 * drafts too), content-addressed and handed to the delivery cache so `/v1/docs/:ref` serves them.
 * Returns screen key → ref. Drafts that don't parse are left out (the released version shows).
 */
export async function draftRefs(ctx: ServerContext, projectId: string, only?: readonly string[]) {
  const rows = await ctx.db
    .select({ key: documents.key, kind: documents.kind, content: drafts.content })
    .from(documents)
    .innerJoin(drafts, eq(drafts.documentId, documents.id))
    .where(and(eq(documents.projectId, projectId), isNull(documents.archivedAt)));
  const blocks = new Map<string, Document>();
  for (const row of rows) {
    if (row.kind !== 'block') continue;
    const parsed = documentSchema.safeParse(row.content);
    if (parsed.success) blocks.set(row.key, parsed.data);
  }
  const refs = new Map<string, string>();
  for (const row of rows) {
    if (row.kind !== 'screen' || (only && !only.includes(row.key))) continue;
    const parsed = documentSchema.safeParse(row.content);
    if (!parsed.success) continue;
    const content = expandBlocks(parsed.data, (key) => blocks.get(key)).document;
    const ref = contentRef('screen', content);
    ctx.delivery.put(ref, content);
    refs.set(row.key, ref);
  }
  return refs;
}
