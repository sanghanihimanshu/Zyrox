import { z } from 'zod';
import type { ActionDef, ComponentDef } from './define';
import type { JsonSchema, Manifest, ManifestBody, ManifestComponent } from './types';
import { PROTOCOL_VERSION } from './types';

function toSchema(schema: z.ZodType): JsonSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  }) as JsonSchema;
  return rest;
}

export function componentManifest(def: ComponentDef): ManifestComponent {
  const events: Record<string, JsonSchema> = {};
  for (const [name, schema] of Object.entries(def.events)) {
    events[name] = schema ? toSchema(schema as z.ZodType) : {};
  }
  return {
    ...(def.description ? { description: def.description } : {}),
    ...(def.source ? { source: def.source } : {}),
    props: toSchema(def.props),
    events,
    children: def.children,
    slots: [...def.slots],
    templates: [...def.templates],
    ...(def.bind ? { bind: { ...def.bind } } : {}),
  };
}

export interface ManifestInput {
  components: readonly ComponentDef[];
  actions?: readonly ActionDef[];
  helpers?: readonly string[];
  motions?: readonly string[];
  transitions?: readonly string[];
  /** Design tokens by group, e.g. `{ color: { primary: '#4f46e5' } }`. */
  tokens?: Record<string, Record<string, string | number>>;
}

/** Builds the manifest for one app build. The hash is stable across platforms and runs. */
export function buildManifest(input: ManifestInput): Manifest {
  const body: ManifestBody = {
    protocol: PROTOCOL_VERSION,
    components: {},
    actions: {},
    helpers: [],
    motions: [],
    transitions: [],
    tokens: {},
  };
  for (const def of input.components) {
    if (body.components[def.name]) throw new Error(`Component "${def.name}" is registered twice`);
    body.components[def.name] = componentManifest(def);
  }
  for (const def of input.actions ?? []) {
    if (body.actions[def.name]) throw new Error(`Action "${def.name}" is registered twice`);
    body.actions[def.name] = {
      ...(def.description ? { description: def.description } : {}),
      args: toSchema(def.args),
    };
  }
  body.helpers = [...new Set(input.helpers ?? [])].sort();
  body.motions = [...new Set(input.motions ?? [])].sort();
  body.transitions = [...new Set(input.transitions ?? [])].sort();
  body.tokens = input.tokens ?? {};
  return { hash: `m_${hashString(canonicalJson(body))}`, ...body };
}

/** JSON with object keys sorted, so equal values always serialize to equal strings. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Fast non-cryptographic 106-bit hash (two cyrb53 runs), hex encoded. Works on every JS engine. */
export function hashString(input: string): string {
  return (
    cyrb53(input, 0x5a7d).toString(16).padStart(14, '0') +
    cyrb53(input, 0x1f3b).toString(16).padStart(14, '0')
  );
}

function cyrb53(str: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
