import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db';
import {
  documents,
  environments,
  experiments,
  projects,
  type ReleaseRule,
  releases,
  versions,
} from '../db/schema';
import type { ExperimentInfo } from './rules';

export interface EnvironmentSnapshot {
  environment: typeof environments.$inferSelect;
  project: typeof projects.$inferSelect;
  releases: {
    documentKey: string;
    kind: string;
    defaultVersionId: string;
    rules: ReleaseRule[];
  }[];
  /** version id → ref (+ locale for strings) */
  versions: Map<string, { ref: string; locale?: string }>;
  experiments: Map<string, ExperimentInfo>;
}

const TTL_MS = 5000;
const MAX_CONTENT = 2000;
const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

/** Immutable content, serialized once and compressed once per encoding. */
export class EncodedContent {
  private readonly encodings = new Map<'br' | 'gzip', Promise<Buffer>>();

  constructor(readonly json: string) {}

  encoded(encoding: 'br' | 'gzip'): Promise<Buffer> {
    let pending = this.encodings.get(encoding);
    if (!pending) {
      pending =
        encoding === 'br'
          ? brotliAsync(this.json, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } })
          : gzipAsync(this.json, { level: 9 });
      this.encodings.set(encoding, pending);
    }
    return pending;
  }
}

/**
 * Everything the bootstrap endpoint needs for one environment, cached for a few seconds and
 * invalidated in-process whenever releases change.
 */
export class DeliveryCache {
  private readonly byKey = new Map<
    string,
    { at: number; snapshot: Promise<EnvironmentSnapshot | undefined> }
  >();
  private readonly docs = new Map<string, EncodedContent>();

  constructor(private readonly db: Db) {}

  invalidate(): void {
    this.byKey.clear();
  }

  environment(publicKey: string): Promise<EnvironmentSnapshot | undefined> {
    const cached = this.byKey.get(publicKey);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.snapshot;
    const snapshot = this.load(publicKey).catch((err) => {
      this.byKey.delete(publicKey);
      throw err;
    });
    this.byKey.set(publicKey, { at: Date.now(), snapshot });
    return snapshot;
  }

  private async load(publicKey: string): Promise<EnvironmentSnapshot | undefined> {
    const [row] = await this.db
      .select({ environment: environments, project: projects })
      .from(environments)
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .where(eq(environments.publicKey, publicKey));
    if (!row) return undefined;
    const releaseRows = await this.db
      .select({ release: releases, key: documents.key, kind: documents.kind })
      .from(releases)
      .innerJoin(documents, eq(documents.id, releases.documentId))
      .where(eq(releases.environmentId, row.environment.id));
    const ids = new Set<string>();
    for (const r of releaseRows) {
      ids.add(r.release.defaultVersionId);
      for (const rule of r.release.rules) if (rule.versionId) ids.add(rule.versionId);
    }
    const experimentRows = await this.db
      .select()
      .from(experiments)
      .where(eq(experiments.projectId, row.project.id));
    for (const e of experimentRows) for (const v of e.variants) ids.add(v.versionId);
    const versionMap = new Map<string, { ref: string; locale?: string }>();
    if (ids.size) {
      const versionRows = await this.db
        .select({
          id: versions.id,
          ref: versions.ref,
          kind: documents.kind,
          locale: sql<string | null>`${versions.content}->>'locale'`,
        })
        .from(versions)
        .innerJoin(documents, eq(documents.id, versions.documentId))
        .where(inArray(versions.id, [...ids]));
      for (const v of versionRows) {
        versionMap.set(v.id, {
          ref: v.ref,
          locale: v.kind === 'strings' ? (v.locale ?? undefined) : undefined,
        });
      }
    }
    return {
      environment: row.environment,
      project: row.project,
      releases: releaseRows.map((r) => ({
        documentKey: r.key,
        kind: r.kind,
        defaultVersionId: r.release.defaultVersionId,
        rules: r.release.rules,
      })),
      versions: versionMap,
      experiments: new Map(
        experimentRows.map((e) => [e.id, { key: e.key, status: e.status, variants: e.variants }]),
      ),
    };
  }

  /** Adds content that isn't a stored version (draft previews), so `content(ref)` serves it. */
  put(ref: string, content: unknown): void {
    if (this.docs.has(ref)) return;
    this.docs.set(ref, new EncodedContent(JSON.stringify(content)));
    if (this.docs.size > MAX_CONTENT) this.docs.delete(this.docs.keys().next().value!);
  }

  /** Immutable content by ref, serialized and compressed once (cached, least recently used evicted). */
  async content(ref: string): Promise<EncodedContent | undefined> {
    const hit = this.docs.get(ref);
    if (hit) {
      this.docs.delete(ref);
      this.docs.set(ref, hit);
      return hit;
    }
    const [row] = await this.db
      .select({ content: versions.content })
      .from(versions)
      .where(eq(versions.ref, ref))
      .limit(1);
    if (!row) return undefined;
    const entry = new EncodedContent(JSON.stringify(row.content));
    this.docs.set(ref, entry);
    if (this.docs.size > MAX_CONTENT) this.docs.delete(this.docs.keys().next().value!);
    return entry;
  }
}
