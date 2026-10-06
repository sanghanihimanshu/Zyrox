import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createZyroxServer, type ZyroxServer } from '@wishyor/zyrox-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import counterJson from '../../../examples/components/documents/counter.json';
import productJson from '../../../examples/components/documents/product.json';
import { exampleManifestInput } from '../../../examples/components/src/manifest';
import {
  Api,
  type Context,
  exportProject,
  importProject,
  loadConfig,
  manifestPush,
  mcpSetup,
  parseProp,
  previewToken,
  pull,
  push,
  scaffold,
  skillsInstall,
  skillsRules,
  snapshot,
  validate,
} from '../src';

const exec = promisify(execFile);
let server: ZyroxServer;
let endpoint = '';
let stop: () => Promise<void>;
let token = '';
let publicKey = '';
const lines: string[] = [];

function ctx(root: string): Context {
  return {
    config: { project: 'shop', manifest: exampleManifestInput },
    root,
    api: new Api(endpoint, token),
    log: (l) => lines.push(l),
  };
}

beforeAll(async () => {
  server = await createZyroxServer({ database: 'memory://', counterIntervalMs: 0 });
  const listening = await server.listen(0, '127.0.0.1');
  endpoint = `http://127.0.0.1:${listening.port}`;
  stop = listening.close;
  // Sign up in the browser way (session cookie), then mint a personal access token for the CLI.
  const signup = await fetch(`${endpoint}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ci@example.com', password: 'password123' }),
  });
  const cookie = signup.headers.get('set-cookie')!.split(';')[0]!;
  const minted = await fetch(`${endpoint}/api/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'ci' }),
  });
  token = ((await minted.json()) as { token: string }).token;
  const session = new Api(endpoint, token);
  const project = await session.request<{ environments: { key: string; publicKey: string }[] }>(
    'POST',
    '/api/projects',
    { name: 'Shop', slug: 'shop' },
  );
  publicKey = project.environments.find((e) => e.key === 'dev')!.publicKey;
});

afterAll(async () => {
  await stop?.();
  await server?.close();
});

describe('zyrox cli', () => {
  it('uploads the manifest, pushes, publishes, pulls and snapshots documents', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zyrox-cli-'));
    await mkdir(join(dir, 'zyrox', 'strings'), { recursive: true });
    await writeFile(join(dir, 'zyrox', 'counter.json'), JSON.stringify(counterJson));
    await writeFile(join(dir, 'zyrox', 'product.json'), JSON.stringify(productJson));
    await writeFile(
      join(dir, 'zyrox', 'strings', 'fr.json'),
      JSON.stringify({ zyrox: 1, kind: 'strings', locale: 'fr', messages: { hi: 'Salut' } }),
    );

    expect((await manifestPush(ctx(dir), '1.0.0')).components).toBe(13);

    const first = await push(ctx(dir), { publish: true, release: ['dev'], message: 'from git' });
    expect(first).toEqual([
      { key: 'counter', action: 'created', version: 1 },
      { key: 'product', action: 'created', version: 1 },
      { key: 'strings/fr', action: 'created', version: 1 },
    ]);
    const again = await push(ctx(dir));
    expect(again.map((r) => r.action)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    await writeFile(
      join(dir, 'zyrox', 'counter.json'),
      JSON.stringify({ ...counterJson, title: 'Counter 2' }),
    );
    expect((await push(ctx(dir))).find((r) => r.key === 'counter')!.action).toBe('updated');

    const out = await mkdtemp(join(tmpdir(), 'zyrox-pull-'));
    expect(await pull(ctx(out))).toEqual(['counter', 'product', 'strings/fr']);
    expect(JSON.parse(await readFile(join(out, 'zyrox', 'counter.json'), 'utf8')).title).toBe('Counter 2');
    expect(JSON.parse(await readFile(join(out, 'zyrox', 'strings', 'fr.json'), 'utf8')).messages).toEqual({
      hi: 'Salut',
    });

    const snap = await snapshot(endpoint, publicKey, '', join(dir, 'snapshot.json'));
    expect(Object.keys(snap.bootstrap.docs).sort()).toEqual(['counter', 'product']);
    expect(Object.keys(snap.docs)).toHaveLength(2);
    expect(Object.values(snap.strings ?? {})[0]).toMatchObject({ locale: 'fr' });
    expect(snap.bootstrap.ttl).toBe(0);
  });

  it('exports, imports and issues draft preview tokens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zyrox-export-'));
    const file = await exportProject(ctx(dir), { versions: true });
    expect(file).toBe(join(dir, 'shop.zyrox.json'));
    const bundle = JSON.parse(await readFile(file, 'utf8'));
    expect(bundle.documents.map((d: { key: string }) => d.key)).toEqual(['counter', 'product', 'strings/fr']);
    expect(bundle.releases.length).toBeGreaterThan(0);

    await new Api(endpoint, token).request('POST', '/api/projects', { name: 'Copy', slug: 'shop-copy' });
    const copy = { ...ctx(dir), config: { ...ctx(dir).config, project: 'shop-copy' } };
    lines.length = 0;
    const summary = await importProject(copy, 'shop.zyrox.json');
    expect([...summary.created].sort()).toEqual(['counter', 'product', 'strings/fr']);
    expect(summary.problems).toEqual([]);
    expect(summary.versions).toBeGreaterThanOrEqual(3);
    expect(lines[0]).toMatch(/^✓ 3 created, 0 updated, 0 kept/);
    expect((await importProject(copy, 'shop.zyrox.json', { overwrite: true })).updated).toHaveLength(3);

    lines.length = 0;
    const issued = await previewToken(ctx(dir), { minutes: 30, documents: ['counter'] });
    expect(issued.token).toMatch(/^zpv_/);
    expect(lines).toEqual([issued.token]);
    const res = await fetch(`${endpoint}/v1/bootstrap`, {
      headers: { authorization: `Bearer ${publicKey}`, 'x-zyrox-preview': issued.token },
    });
    expect(((await res.json()) as { preview?: boolean }).preview).toBe(true);
  });

  it('validates local documents against the manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zyrox-validate-'));
    await mkdir(join(dir, 'zyrox'));
    await writeFile(join(dir, 'zyrox', 'product.json'), JSON.stringify(productJson));
    await writeFile(
      join(dir, 'zyrox', 'broken.json'),
      JSON.stringify({
        zyrox: 1,
        kind: 'screen',
        key: 'broken',
        root: { id: 'r', type: 'Screen', children: [{ id: 'b', type: 'Button' }] },
      }),
    );
    const report = await validate(ctx(dir), []);
    const byFile = Object.fromEntries(
      report.map((r) => [r.file.split('/').pop(), r.problems.map((p) => `${p.level}:${p.code}`)]),
    );
    expect(byFile).toEqual({
      'broken.json': ['error:missing_prop'],
      'product.json': ['warning:unknown_component'],
    });
  });

  it('loads zyrox.config.ts and runs as a binary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zyrox-config-'));
    const manifestPath = resolve(import.meta.dirname, '../../../examples/components/src/manifest.ts');
    await writeFile(
      join(dir, 'zyrox.config.ts'),
      `import { exampleManifestInput } from ${JSON.stringify(manifestPath)};\nexport default { project: 'shop', server: ${JSON.stringify(endpoint)}, manifest: exampleManifestInput };\n`,
    );
    const loaded = await loadConfig(undefined, dir);
    expect(loaded.config.project).toBe('shop');
    await mkdir(join(dir, 'zyrox'));
    await writeFile(join(dir, 'zyrox', 'counter.json'), JSON.stringify(counterJson));
    const bin = resolve(import.meta.dirname, '../src/bin.ts');
    const tsx = resolve(import.meta.dirname, '../node_modules/.bin/tsx');
    const { stdout } = await exec(tsx, [bin, 'validate'], {
      cwd: dir,
      env: { ...process.env, ZYROX_TOKEN: token },
    });
    expect(stdout).toContain('✓ zyrox/counter.json');
    const built = await exec(tsx, [bin, 'manifest', 'build'], { cwd: dir });
    expect(JSON.parse(built.stdout).components.Button).toBeTruthy();
    const pushed = await exec(tsx, [bin, 'push', '--publish', '--release', 'dev'], {
      cwd: dir,
      env: { ...process.env, ZYROX_TOKEN: token },
    });
    expect(pushed.stdout).toContain('↑ counter');
  });

  it('sets up agents: skills, design-system rules, scaffolding and MCP', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zyrox-agents-'));
    const out: string[] = [];
    const c = { ...ctx(dir), log: (l: string) => out.push(l) };
    expect(skillsInstall(c, { names: ['zyrox-screens'] }).installed).toEqual(['zyrox-screens']);
    expect(await readFile(join(dir, '.claude/skills/zyrox-screens/SKILL.md'), 'utf8')).toContain(
      'name: zyrox-screens',
    );

    const rules = await skillsRules(c, '.claude/rules/zyrox.md');
    expect(rules).toContain('### Button');
    expect(await readFile(join(dir, '.claude/rules/zyrox.md'), 'utf8')).toBe(rules);

    expect(parseProp('title:string!')).toEqual(['title', { type: 'string', optional: false }]);
    expect(parseProp('tone:default|promo=promo')).toEqual([
      'tone',
      { type: 'enum', values: ['default', 'promo'], default: 'promo' },
    ]);
    expect(parseProp('price:number=0')).toEqual(['price', { type: 'number', default: 0 }]);
    expect(() => parseProp('bad')).toThrow(/Bad --prop/);
    expect(() => parseProp('x:float')).toThrow(/Unknown prop type/);

    const spec = {
      name: 'Rating',
      props: Object.fromEntries([parseProp('value:integer=0')]),
      bind: { prop: 'value', event: 'change' },
    };
    await scaffold(c, spec);
    expect(await readFile(join(dir, 'src/zyrox/components/rating/def.ts'), 'utf8')).toContain(
      "bind: { prop: 'value', event: 'change' },",
    );
    await expect(scaffold(c, spec)).rejects.toThrow(/Already exists/);

    expect(mcpSetup(c)).toBe(`${endpoint}/mcp`);
    expect(out.join('\n')).toContain(`claude mcp add --transport http zyrox ${endpoint}/mcp`);

    const bin = resolve(import.meta.dirname, '../src/bin.ts');
    const tsx = resolve(import.meta.dirname, '../node_modules/.bin/tsx');
    const { stdout } = await exec(
      tsx,
      [
        bin,
        'scaffold',
        'component',
        'PromoBanner',
        '--prop',
        'title:string!',
        '--prop',
        'tone:info|sale=info',
        '--event',
        'press',
        '--platform',
        'native',
        '--dry-run',
      ],
      { cwd: dir },
    );
    expect(stdout).toContain('// src/zyrox/components/promo-banner/PromoBanner.native.tsx');
    expect(stdout).not.toContain('PromoBanner.tsx\n');
    const listed = await exec(tsx, [bin, 'skills', 'list'], { cwd: dir });
    expect(listed.stdout).toContain('zyrox-performance');
  });
});
