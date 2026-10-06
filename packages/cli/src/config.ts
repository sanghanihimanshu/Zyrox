import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildManifest, type Manifest, type ManifestInput } from '@zyrox/protocol';

export interface ZyroxConfig {
  /** Zyrox server URL. */
  server?: string;
  /** Project slug. */
  project?: string;
  /** What your app build supports: the same input your registry uses (or a built manifest). */
  manifest?: ManifestInput | Manifest;
  /** Folder for `zyrox pull` / `zyrox push`. Default `./zyrox`. */
  documents?: string;
}

/** Typed helper for `zyrox.config.ts`. */
export function defineConfig(config: ZyroxConfig): ZyroxConfig {
  return config;
}

export interface Resolved {
  config: ZyroxConfig;
  /** Directory of the config file (paths are relative to it). */
  root: string;
}

const CONFIG_NAMES = ['zyrox.config.ts', 'zyrox.config.mts', 'zyrox.config.js', 'zyrox.config.mjs'];

export async function loadConfig(path?: string, cwd = process.cwd()): Promise<Resolved> {
  const file = path ? resolve(cwd, path) : CONFIG_NAMES.map((n) => join(cwd, n)).find((p) => existsSync(p));
  if (!file) return { config: {}, root: cwd };
  if (!existsSync(file)) throw new Error(`Config not found: ${file}`);
  const { tsImport } = await import('tsx/esm/api');
  let config: unknown = await tsImport(pathToFileURL(file).href, import.meta.url);
  // A config compiled as CommonJS arrives as `{ default: { default: config } }`.
  while (config && typeof config === 'object' && 'default' in config)
    config = (config as { default: unknown }).default;
  return { config: (config as ZyroxConfig) ?? {}, root: dirname(file) };
}

export function resolveManifest(config: ZyroxConfig): Manifest {
  const m = config.manifest;
  if (!m) throw new Error('Set `manifest` in zyrox.config.ts (your component and action definitions)');
  return 'hash' in m ? (m as Manifest) : buildManifest(m as ManifestInput);
}

const credentialsFile = () =>
  join(process.env.ZYROX_CONFIG_DIR ?? join(homedir(), '.config', 'zyrox'), 'credentials.json');

export async function readCredentials(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(credentialsFile(), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function saveCredential(server: string, token: string): Promise<void> {
  const all = await readCredentials();
  all[server] = token;
  await mkdir(dirname(credentialsFile()), { recursive: true });
  await writeFile(credentialsFile(), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
}
