import { hasErrors, type Problem, validateDocument } from '@wishyor/zyrox-core/validate';
import {
  canonicalJson,
  type Document,
  documentSchema,
  type Manifest,
  stringsBundleSchema,
} from '@wishyor/zyrox-protocol';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { sha256, today } from '../crypto';
import type { Db } from '../db';
import {
  type DocumentKind,
  documents,
  environments,
  manifests,
  manifestTraffic,
  versions,
} from '../db/schema';
import { expandBlocks, referencedBlocks } from './blocks';

/** Codes that break rendering on an app build (as opposed to cosmetic warnings). */
const BREAKING = new Set([
  'unknown_component',
  'missing_prop',
  'unknown_action',
  'unknown_helper',
  'not_bindable',
  'invalid_action_args',
]);

export interface CompatEntry {
  hash: string;
  label: string;
  /** Share of the project's traffic in the last 30 days (0–1). */
  share: number;
  problems: Problem[];
}

export interface CompileResult {
  content: unknown;
  ref: string;
  problems: Problem[];
  compat: CompatEntry[];
  /** Blocks included in this version. */
  blocks: string[];
  manifest?: { hash: string; label: string };
}

export async function latestManifest(
  db: Db,
  projectId: string,
): Promise<{ manifest: Manifest; label: string } | undefined> {
  const [row] = await db
    .select()
    .from(manifests)
    .where(eq(manifests.projectId, projectId))
    .orderBy(desc(manifests.uploadedAt))
    .limit(1);
  return row ? { manifest: row.content as Manifest, label: row.label } : undefined;
}

/** Manifests seen in traffic recently, with their share of requests. */
export async function activeManifests(db: Db, projectId: string, days = 30) {
  const since = today(new Date(Date.now() - days * 86_400_000));
  const rows = await db
    .select({ hash: manifestTraffic.hash, count: sql<number>`sum(${manifestTraffic.count})::int` })
    .from(manifestTraffic)
    .innerJoin(environments, eq(environments.id, manifestTraffic.environmentId))
    .where(and(eq(environments.projectId, projectId), gte(manifestTraffic.day, since)))
    .groupBy(manifestTraffic.hash);
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  if (!rows.length) return [];
  const known = await db
    .select()
    .from(manifests)
    .where(
      and(
        eq(manifests.projectId, projectId),
        inArray(
          manifests.hash,
          rows.map((r) => r.hash),
        ),
      ),
    );
  const byHash = new Map(known.map((m) => [m.hash, m]));
  return rows
    .map((r) => ({
      hash: r.hash,
      count: r.count,
      share: total ? r.count / total : 0,
      manifest: byHash.get(r.hash),
    }))
    .sort((a, b) => b.count - a.count);
}

/** Latest published content of each block, by key. */
async function publishedBlocks(db: Db, projectId: string, keys: string[]): Promise<Map<string, Document>> {
  const out = new Map<string, Document>();
  const pending = [...keys];
  const seen = new Set<string>();
  while (pending.length) {
    const batch = pending.splice(0).filter((k) => !seen.has(k));
    if (!batch.length) break;
    for (const k of batch) seen.add(k);
    const rows = await db
      .select({ key: documents.key, source: versions.source, number: versions.number })
      .from(versions)
      .innerJoin(documents, eq(documents.id, versions.documentId))
      .where(
        and(eq(documents.projectId, projectId), eq(documents.kind, 'block'), inArray(documents.key, batch)),
      )
      .orderBy(desc(versions.number));
    for (const row of rows) {
      if (out.has(row.key)) continue;
      const doc = row.source as Document;
      out.set(row.key, doc);
      pending.push(...referencedBlocks(doc));
    }
  }
  return out;
}

export function contentRef(kind: DocumentKind, content: unknown): string {
  return `${kind === 'strings' ? 's' : 'd'}_${sha256(canonicalJson(content)).slice(0, 40)}`;
}

/**
 * Turns a draft into what clients receive: validates structure, expands blocks, checks it
 * against the latest app manifest and every app build seen in recent traffic.
 */
export async function compileDraft(
  db: Db,
  projectId: string,
  kind: DocumentKind,
  draft: unknown,
): Promise<CompileResult> {
  if (kind === 'strings') {
    const parsed = stringsBundleSchema.safeParse(draft);
    if (!parsed.success) {
      return {
        content: draft,
        ref: '',
        problems: parsed.error.issues.map((i) => ({
          level: 'error',
          code: 'schema',
          message: i.message,
          path: i.path.join('.'),
        })),
        compat: [],
        blocks: [],
      };
    }
    return { content: parsed.data, ref: contentRef(kind, parsed.data), problems: [], compat: [], blocks: [] };
  }

  const parsed = documentSchema.safeParse(draft);
  if (!parsed.success) {
    return { content: draft, ref: '', problems: validateDocument(draft), compat: [], blocks: [] };
  }
  const blocks = await publishedBlocks(db, projectId, referencedBlocks(parsed.data));
  const expanded = expandBlocks(parsed.data, (key) => blocks.get(key));
  const content = expanded.document;
  const globals = kind === 'block' ? ['input'] : [];
  const latest = await latestManifest(db, projectId);
  const problems = [
    ...expanded.problems,
    ...validateDocument(content, { manifest: latest?.manifest, globals }),
  ];

  const compat: CompatEntry[] = [];
  for (const active of await activeManifests(db, projectId)) {
    if (!active.manifest || active.manifest.hash === latest?.manifest.hash) continue;
    const breaking = validateDocument(content, {
      manifest: active.manifest.content as Manifest,
      globals,
    }).filter((p) => p.level === 'error' && BREAKING.has(p.code));
    if (breaking.length) {
      compat.push({
        hash: active.hash,
        label: active.manifest.label,
        share: active.share,
        problems: breaking.slice(0, 10),
      });
    }
  }
  return {
    content,
    ref: contentRef(kind, content),
    problems,
    compat,
    blocks: expanded.used,
    manifest: latest ? { hash: latest.manifest.hash, label: latest.label } : undefined,
  };
}

export { hasErrors };
