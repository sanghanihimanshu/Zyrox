#!/usr/bin/env -S npx tsx
import { Command } from 'commander';
import { mcpSetup, parseProp, scaffold, skillsInstall, skillsList, skillsRules } from './agents';
import { Api } from './api';
import {
  type Context,
  exportProject,
  importProject,
  manifestBuild,
  manifestPush,
  previewToken,
  pull,
  push,
  snapshot,
  validate,
  whoami,
} from './commands';
import { loadConfig, readCredentials, resolveManifest, saveCredential } from './config';

const program = new Command('zyrox')
  .description('Zyrox: server-driven UI for React and React Native')
  .option('-c, --config <file>', 'path to zyrox.config.ts')
  .option('-s, --server <url>', 'Zyrox server URL (or ZYROX_SERVER)')
  .option('-p, --project <slug>', 'project slug (or ZYROX_PROJECT)');

async function context(): Promise<Context> {
  const opts = program.opts<{ config?: string; server?: string; project?: string }>();
  const resolved = await loadConfig(opts.config);
  const server = opts.server ?? process.env.ZYROX_SERVER ?? resolved.config.server ?? 'http://localhost:4400';
  const token = process.env.ZYROX_TOKEN ?? (await readCredentials())[server];
  return {
    ...resolved,
    api: new Api(server, token),
    project: opts.project ?? process.env.ZYROX_PROJECT,
    log: (line) => console.log(line),
  };
}

const run =
  (fn: (...args: any[]) => Promise<unknown>) =>
  async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  };

program
  .command('login')
  .description('Save a personal access token (create one in the dashboard under Settings → Tokens)')
  .requiredOption('-t, --token <token>', 'personal access token (zyx_…)')
  .action(
    run(async (opts: { token: string }) => {
      const ctx = await context();
      const api = new Api(ctx.api.server, opts.token);
      await whoami({ ...ctx, api });
      await saveCredential(ctx.api.server, opts.token);
      console.log('Saved.');
    }),
  );

program
  .command('whoami')
  .description('Show the signed-in user and projects')
  .action(run(async () => whoami(await context())));

const manifest = program.command('manifest').description('What your app build supports');
manifest
  .command('build')
  .description('Print or write the manifest from zyrox.config.ts')
  .option('-o, --out <file>', 'write to a file')
  .action(
    run(async (opts: { out?: string }) => {
      const ctx = await context();
      const m = await manifestBuild(ctx, opts.out);
      if (!opts.out) console.log(JSON.stringify(m, null, 2));
    }),
  );
manifest
  .command('push')
  .description('Upload the manifest (run in CI for every app build)')
  .option('-l, --label <label>', 'e.g. the app version or commit')
  .action(run(async (opts: { label?: string }) => manifestPush(await context(), opts.label)));

program
  .command('pull')
  .description('Download drafts as JSON files')
  .option('-d, --dir <dir>', 'folder (default: `documents` in config or ./zyrox)')
  .action(run(async (opts: { dir?: string }) => pull(await context(), opts.dir)));

program
  .command('push')
  .description('Upload JSON files as drafts, optionally publish and release')
  .option('-d, --dir <dir>', 'folder (default: `documents` in config or ./zyrox)')
  .option('--publish', 'publish each document after uploading')
  .option('-r, --release <envs>', 'comma-separated environments to release to, e.g. dev,staging')
  .option('-m, --message <message>', 'version message')
  .action(
    run(async (opts: { dir?: string; publish?: boolean; release?: string; message?: string }) =>
      push(await context(), {
        dir: opts.dir,
        publish: opts.publish,
        release: opts.release
          ?.split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        message: opts.message,
      }),
    ),
  );

program
  .command('validate [files...]')
  .description('Validate local documents against your manifest (no server needed)')
  .action(
    run(async (files: string[]) => {
      const report = await validate(await context(), files);
      if (report.some((r) => r.problems.some((p) => p.level === 'error'))) process.exitCode = 1;
    }),
  );

program
  .command('export')
  .description('Export the project: drafts and settings (with --versions, history and releases)')
  .option('-o, --out <file>', 'output file (default <project>.zyrox.json)')
  .option('--versions', 'include version history and releases')
  .action(
    run(async (opts: { out?: string; versions?: boolean }) =>
      exportProject(await context(), { out: opts.out, versions: opts.versions }),
    ),
  );

program
  .command('import <file>')
  .description('Import an export into the project (existing documents are kept unless --overwrite)')
  .option('--overwrite', 'replace drafts of documents that exist')
  .action(
    run(async (file: string, opts: { overwrite?: boolean }) =>
      importProject(await context(), file, { overwrite: opts.overwrite }),
    ),
  );

program
  .command('preview-token')
  .description('Print a draft preview token for app builds (previewToken) and SSR draft mode')
  .option('-m, --minutes <n>', 'lifetime in minutes (default 1440)', (v) => Number(v))
  .option('-d, --documents <keys>', 'comma-separated document keys (default: all)')
  .action(
    run(async (opts: { minutes?: number; documents?: string }) =>
      previewToken(await context(), {
        minutes: opts.minutes,
        documents: opts.documents
          ?.split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    ),
  );

program
  .command('snapshot')
  .description('Build an offline snapshot to bundle in your app')
  .requiredOption('-k, --public-key <key>', 'environment public key (pk_…)')
  .option('-o, --out <file>', 'output file', 'zyrox.snapshot.json')
  .action(
    run(async (opts: { publicKey: string; out: string }) => {
      const ctx = await context();
      let hash = '';
      try {
        hash = resolveManifest(ctx.config).hash;
      } catch {
        // snapshot without a manifest
      }
      await snapshot(ctx.api.server, opts.publicKey, hash, opts.out, ctx.log);
    }),
  );

const skills = program.command('skills').description('Agent Skills and design-system rules for AI agents');
skills
  .command('list')
  .description('List the bundled skills')
  .action(run(async () => skillsList({ log: (l) => console.log(l) })));
skills
  .command('install [names...]')
  .description('Copy the skills into your project (default .claude/skills)')
  .option('-d, --dir <dir>', 'skills folder', '.claude/skills')
  .option('-f, --force', 'replace skills that already exist')
  .action(
    run(async (names: string[], opts: { dir: string; force?: boolean }) =>
      skillsInstall(await context(), { names, dir: opts.dir, force: opts.force }),
    ),
  );
skills
  .command('rules')
  .description("Generate design-system rules for agents from your app's manifest")
  .option('-o, --out <file>', 'write to a file, e.g. .claude/rules/zyrox-design-system.md')
  .action(run(async (opts: { out?: string }) => skillsRules(await context(), opts.out)));

const collect = (value: string, previous: string[] = []) => [...previous, value];
program
  .command('scaffold')
  .description('Generate a component: definition plus web and React Native implementations')
  .argument('<kind>', '"component"')
  .argument('<name>', 'PascalCase name, e.g. ProductCard')
  .option('--description <text>', 'what it is and when to use it')
  .option('--prop <spec>', 'name:type[!][=default], or name:a|b=a for enums (repeatable)', collect)
  .option('--event <name>', 'event, e.g. press (repeatable)', collect)
  .option('--slot <name>', 'named slot (repeatable)', collect)
  .option('--template <name>', 'item template for lists (repeatable)', collect)
  .option('--children', 'accepts children')
  .option('--bind <prop:event>', 'two-way binding, e.g. value:change')
  .option('-d, --dir <dir>', 'components folder', 'src/zyrox/components')
  .option('--platform <name>', 'web or native (repeatable; default both)', collect)
  .option('--dry-run', 'print instead of writing')
  .action(
    run(
      async (
        kind: string,
        name: string,
        opts: {
          description?: string;
          prop?: string[];
          event?: string[];
          slot?: string[];
          template?: string[];
          children?: boolean;
          bind?: string;
          dir: string;
          platform?: ('web' | 'native')[];
          dryRun?: boolean;
        },
      ) => {
        if (kind !== 'component') throw new Error('Only "zyrox scaffold component <Name>" is supported');
        const [bindProp, bindEvent] = opts.bind?.split(':') ?? [];
        await scaffold(
          await context(),
          {
            name,
            description: opts.description,
            props: Object.fromEntries((opts.prop ?? []).map(parseProp)),
            events: opts.event,
            slots: opts.slot,
            templates: opts.template,
            children: opts.children,
            bind: bindProp && bindEvent ? { prop: bindProp, event: bindEvent } : undefined,
            dir: opts.dir,
            platforms: opts.platform,
          },
          opts.dryRun,
        );
      },
    ),
  );

program
  .command('mcp')
  .description('Show how to connect AI agents (Claude Code, Cursor…) to the Zyrox MCP server')
  .action(run(async () => mcpSetup(await context())));

await program.parseAsync();
