import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import type { Manifest } from '@zyrox/protocol';
import {
  type ComponentSpec,
  designSystemRules,
  installSkills,
  listSkills,
  PROP_TYPES,
  type PropSpec,
  type PropType,
  scaffoldComponent,
} from '@zyrox/skills';
import type { Context } from './commands';
import { resolveManifest } from './config';

export function skillsList(ctx: Pick<Context, 'log'>) {
  const skills = listSkills();
  for (const s of skills) ctx.log(`${s.name}\n  ${s.description}`);
  return skills;
}

/** Copies the Zyrox Agent Skills into a project (default `.claude/skills`). */
export function skillsInstall(
  ctx: Pick<Context, 'root' | 'log'>,
  options: { names?: string[]; dir?: string; force?: boolean } = {},
) {
  const target = resolve(ctx.root, options.dir ?? '.claude/skills');
  const result = installSkills(target, {
    names: options.names?.length ? options.names : undefined,
    overwrite: options.force,
  });
  for (const name of result.installed) ctx.log(`Installed ${relative(process.cwd(), resolve(target, name))}`);
  for (const name of result.skipped) ctx.log(`Skipped ${name} (exists; use --force to replace)`);
  return result;
}

/** Writes design-system rules for agents from the app's manifest (no server needed). */
export async function skillsRules(ctx: Context, out?: string) {
  let manifest: Manifest | undefined;
  try {
    manifest = resolveManifest(ctx.config);
  } catch {
    manifest = undefined;
  }
  const markdown = designSystemRules(manifest, { project: ctx.config.project });
  if (out) {
    const file = resolve(ctx.root, out);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, markdown);
    ctx.log(`Wrote ${relative(process.cwd(), file)}`);
  } else {
    ctx.log(markdown);
  }
  return markdown;
}

/**
 * Parses `--prop` values: `title:string!` (required), `price:number=0`, `image:image`,
 * `tone:default|promo=default` (enum), `tags:string[]`.
 */
export function parseProp(input: string): [string, PropSpec] {
  const match = /^([A-Za-z][A-Za-z0-9]*):([^=!]+)(!)?(?:=(.*))?$/.exec(input.trim());
  if (!match)
    throw new Error(`Bad --prop "${input}". Use name:type, name:type!, name:type=default or name:a|b=a`);
  const [, name, rawType, required, rawDefault] = match;
  const isEnum = rawType!.includes('|');
  const type = (isEnum ? 'enum' : rawType) as PropType;
  if (!PROP_TYPES.includes(type))
    throw new Error(`Unknown prop type "${rawType}". Use ${PROP_TYPES.join(', ')}`);
  const spec: PropSpec = { type };
  if (isEnum)
    spec.values = rawType!
      .split('|')
      .map((v) => v.trim())
      .filter(Boolean);
  if (required) spec.optional = false;
  if (rawDefault !== undefined) {
    spec.default =
      type === 'number' || type === 'integer'
        ? Number(rawDefault)
        : type === 'boolean'
          ? rawDefault === 'true'
          : rawDefault;
  }
  return [name!, spec];
}

/** Writes a scaffolded component into the app. Never overwrites files. */
export async function scaffold(ctx: Pick<Context, 'root' | 'log'>, spec: ComponentSpec, dryRun = false) {
  const result = scaffoldComponent(spec);
  const existing = result.files.filter((f) => existsSync(resolve(ctx.root, f.path)));
  if (existing.length && !dryRun)
    throw new Error(`Already exists: ${existing.map((f) => f.path).join(', ')}`);
  for (const file of result.files) {
    if (dryRun) {
      ctx.log(`// ${file.path}\n${file.content}`);
      continue;
    }
    const path = resolve(ctx.root, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
    ctx.log(`Created ${relative(process.cwd(), path)}`);
  }
  for (const note of result.notes) ctx.log(note);
  ctx.log(`\nNext:\n${result.registration}`);
  return result;
}

/** How to connect AI agents to this server's MCP endpoint. */
export function mcpSetup(ctx: Pick<Context, 'api' | 'log'>) {
  const url = `${ctx.api.server.replace(/\/+$/, '')}/mcp`;
  const lines = [
    `Zyrox MCP endpoint: ${url}`,
    'Authenticate with a personal access token (dashboard → Settings → Tokens), exported as ZYROX_TOKEN.',
    '',
    'Claude Code:',
    `  claude mcp add --transport http zyrox ${url} --header "Authorization: Bearer $ZYROX_TOKEN"`,
    '',
    'Other clients (.mcp.json / mcp.json):',
    JSON.stringify(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: environment variable syntax of .mcp.json
      { mcpServers: { zyrox: { type: 'http', url, headers: { Authorization: 'Bearer ${ZYROX_TOKEN}' } } } },
      null,
      2,
    ),
    '',
    'Then install the guides: npx zyrox skills install',
  ];
  for (const line of lines) ctx.log(line);
  return url;
}
