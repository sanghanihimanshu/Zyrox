import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { Snapshot } from '@wishyor/zyrox-core';
import { type Problem, validateDocument } from '@wishyor/zyrox-core/validate';
import { canonicalJson, type Manifest } from '@wishyor/zyrox-protocol';
import { type Api, ApiError } from './api';
import { type Resolved, resolveManifest } from './config';

export interface Context extends Resolved {
  api: Api;
  project?: string;
  log(line: string): void;
}

function requireProject(ctx: Context): string {
  const project = ctx.project ?? ctx.config.project;
  if (!project) throw new Error('Which project? Pass --project or set `project` in zyrox.config.ts');
  return project;
}

const documentsDir = (ctx: Context, dir?: string) =>
  resolve(ctx.root, dir ?? ctx.config.documents ?? 'zyrox');

export async function whoami(ctx: Context) {
  const me = await ctx.api.request<{
    user: { email: string; name: string };
    projects: { slug: string; role: string }[];
  }>('GET', '/api/me');
  ctx.log(`${me.user.name} <${me.user.email}> on ${ctx.api.server}`);
  for (const p of me.projects) ctx.log(`  ${p.slug} (${p.role})`);
  return me;
}

export async function manifestBuild(ctx: Context, out?: string) {
  const manifest = resolveManifest(ctx.config);
  if (out) {
    const file = resolve(ctx.root, out);
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
    ctx.log(`Wrote ${relative(process.cwd(), file)} (${manifest.hash})`);
  }
  return manifest;
}

export async function manifestPush(ctx: Context, label = '') {
  const manifest = resolveManifest(ctx.config);
  const project = requireProject(ctx);
  const res = await ctx.api.request<{ hash: string; components: number }>(
    'POST',
    `/api/projects/${project}/manifests`,
    { manifest, label },
  );
  ctx.log(`Uploaded manifest ${res.hash} (${res.components} components${label ? `, ${label}` : ''})`);
  return res;
}

interface ListedDocument {
  key: string;
  kind: string;
  revision: number | null;
}

const fileFor = (dir: string, key: string) => join(dir, `${key}.json`);

/** Downloads every draft as `<dir>/<key>.json` so screens can live in git. */
export async function pull(ctx: Context, dir?: string) {
  const project = requireProject(ctx);
  const target = documentsDir(ctx, dir);
  const { documents } = await ctx.api.request<{ documents: ListedDocument[] }>(
    'GET',
    `/api/projects/${project}/documents`,
  );
  for (const doc of documents) {
    const { draft } = await ctx.api.request<{ draft: { content: unknown } }>(
      'GET',
      `/api/projects/${project}/documents/${doc.key}`,
    );
    const file = fileFor(target, doc.key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(draft.content, null, 2)}\n`);
    ctx.log(`↓ ${doc.key}`);
  }
  return documents.map((d) => d.key);
}

async function listJson(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.name.endsWith('.json')) out.push(p);
    }
  };
  await walk(dir);
  return out.sort();
}

export interface PushOptions {
  dir?: string;
  publish?: boolean;
  release?: string[];
  message?: string;
}

/** Uploads `<dir>/**.json` as drafts (creating documents as needed) and optionally publishes. */
export async function push(ctx: Context, options: PushOptions = {}) {
  const project = requireProject(ctx);
  const source = documentsDir(ctx, options.dir);
  const results: { key: string; action: 'created' | 'updated' | 'unchanged'; version?: number }[] = [];
  for (const file of await listJson(source)) {
    const key = relative(source, file)
      .replace(/\\/g, '/')
      .replace(/\.json$/, '');
    const content = JSON.parse(await readFile(file, 'utf8')) as { kind?: string };
    const kind = content.kind === 'strings' ? 'strings' : content.kind === 'block' ? 'block' : 'screen';
    let action: 'created' | 'updated' | 'unchanged' = 'unchanged';
    try {
      const current = await ctx.api.request<{ draft: { content: unknown; revision: number } }>(
        'GET',
        `/api/projects/${project}/documents/${key}`,
      );
      if (canonicalJson(current.draft.content) !== canonicalJson(content)) {
        await ctx.api.request('PUT', `/api/projects/${project}/documents/${key}/draft`, {
          content,
          revision: current.draft.revision,
        });
        action = 'updated';
      }
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) throw err;
      await ctx.api.request('POST', `/api/projects/${project}/documents`, { key, kind, content });
      action = 'created';
    }
    let version: number | undefined;
    if (options.publish) {
      const published = await ctx.api.request<{ version: { number: number } }>(
        'POST',
        `/api/projects/${project}/documents/${key}/publish`,
        {
          message: options.message ?? '',
          release: kind === 'block' ? [] : (options.release ?? []),
        },
      );
      version = published.version.number;
    }
    results.push({ key, action, version });
    ctx.log(`↑ ${key} ${action}${version ? ` → v${version}` : ''}`);
  }
  return results;
}

/** Validates local documents against the app manifest from zyrox.config.ts. */
export async function validate(ctx: Context, files: string[]) {
  let manifest: Manifest | undefined;
  try {
    manifest = resolveManifest(ctx.config);
  } catch {
    ctx.log('No manifest in zyrox.config.ts: checking structure and expressions only');
  }
  const targets = files.length
    ? files.map((f) => resolve(process.cwd(), f))
    : await listJson(documentsDir(ctx));
  const report: { file: string; problems: Problem[] }[] = [];
  for (const file of targets) {
    const doc = JSON.parse(await readFile(file, 'utf8')) as { kind?: string };
    if (doc.kind === 'strings') continue;
    const problems = validateDocument(doc, { manifest, globals: doc.kind === 'block' ? ['input'] : [] });
    report.push({ file, problems });
    const name = relative(process.cwd(), file);
    if (!problems.length) ctx.log(`✓ ${name}`);
    for (const p of problems)
      ctx.log(`${p.level === 'error' ? '✗' : '!'} ${name}${p.nodeId ? ` #${p.nodeId}` : ''}: ${p.message}`);
  }
  return report;
}

/**
 * Builds an offline snapshot (bootstrap + documents + translations) to ship in the app for the
 * first launch with no network.
 */
export async function snapshot(
  server: string,
  publicKey: string,
  manifestHash = '',
  out?: string,
  log: (l: string) => void = () => {},
) {
  const base = server.replace(/\/+$/, '');
  const headers = {
    authorization: `Bearer ${publicKey}`,
    'x-zyrox-client': `platform=snapshot; manifest=${manifestHash}; protocol=1`,
    'x-zyrox-user': 'snapshot',
  };
  const res = await fetch(`${base}/v1/bootstrap`, { headers });
  if (!res.ok) throw new Error(`Bootstrap failed: HTTP ${res.status}`);
  const bootstrap = (await res.json()) as Snapshot['bootstrap'] & {
    strings?: { refs: Record<string, string> };
  };
  const docs: Snapshot['docs'] = {};
  for (const ref of Object.values(bootstrap.docs))
    docs[ref] = await (await fetch(`${base}/v1/docs/${ref}`)).json();
  const strings: NonNullable<Snapshot['strings']> = {};
  for (const ref of Object.values(bootstrap.strings?.refs ?? {}))
    strings[ref] = await (await fetch(`${base}/v1/strings/${ref}`)).json();
  // Experiments are per user; a snapshot always ships the default variants.
  const result: Snapshot = { bootstrap: { ...bootstrap, ttl: 0, experiments: [] }, docs, strings };
  if (out) {
    await mkdir(dirname(resolve(out)), { recursive: true });
    await writeFile(resolve(out), `${JSON.stringify(result)}\n`);
    log(
      `Wrote ${out}: ${Object.keys(docs).length} documents, ${Object.keys(strings).length} translation bundles`,
    );
  }
  return result;
}

/** Writes the project export (drafts, settings; with `versions`, history and releases). */
export async function exportProject(ctx: Context, options: { out?: string; versions?: boolean } = {}) {
  const project = requireProject(ctx);
  const bundle = await ctx.api.request<{ documents: unknown[] }>(
    'GET',
    `/api/projects/${project}/export${options.versions ? '?versions=true' : ''}`,
  );
  const out = resolve(ctx.root, options.out ?? `${project}.zyrox.json`);
  await writeFile(out, `${JSON.stringify(bundle, null, 2)}\n`);
  ctx.log(`✓ ${bundle.documents.length} documents → ${relative(ctx.root, out) || out}`);
  return out;
}

interface ImportSummary {
  created: string[];
  updated: string[];
  skipped: string[];
  versions: number;
  releases: number;
  functions: { name: string; secret: string }[];
  webhooks: { url: string; secret: string }[];
  problems: { document: string; message: string }[];
}

/** Imports an export file into the project. New function and webhook secrets are printed once. */
export async function importProject(ctx: Context, file: string, options: { overwrite?: boolean } = {}) {
  const project = requireProject(ctx);
  const bundle = JSON.parse(await readFile(resolve(ctx.root, file), 'utf8'));
  const summary = await ctx.api.request<ImportSummary>('POST', `/api/projects/${project}/import`, {
    bundle,
    overwrite: Boolean(options.overwrite),
  });
  ctx.log(
    `✓ ${summary.created.length} created, ${summary.updated.length} updated, ${summary.skipped.length} kept` +
      ` · ${summary.versions} versions · ${summary.releases} releases`,
  );
  for (const fn of summary.functions) ctx.log(`  function ${fn.name}: new secret ${fn.secret}`);
  for (const hook of summary.webhooks) ctx.log(`  webhook ${hook.url}: new secret ${hook.secret}`);
  for (const p of summary.problems) ctx.log(`  ! ${p.document}: ${p.message}`);
  return summary;
}

/** A draft preview token for app builds (`previewToken`) and SSR draft mode. */
export async function previewToken(ctx: Context, options: { minutes?: number; documents?: string[] } = {}) {
  const project = requireProject(ctx);
  const issued = await ctx.api.request<{ token: string; expiresAt: string }>(
    'POST',
    `/api/projects/${project}/preview-tokens`,
    {
      ...(options.minutes ? { expiresInMinutes: options.minutes } : {}),
      ...(options.documents?.length ? { documents: options.documents } : {}),
    },
  );
  ctx.log(issued.token);
  return issued;
}
