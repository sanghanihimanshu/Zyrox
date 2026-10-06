import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { findNode, listNodes } from '@wishyor/zyrox-core';
import type { Problem } from '@wishyor/zyrox-core/validate';
import { type Document, type Manifest, type Node, z } from '@wishyor/zyrox-protocol';
import {
  componentProps,
  componentSignature,
  designSystemRules,
  listSkills,
  PROP_TYPES,
  readSkill,
  scaffoldComponent,
} from '@wishyor/zyrox-skills';
import { Hono } from 'hono';
import { currentUser } from '../auth';
import type { AppEnv, ServerContext } from '../context';

/** Calls the admin API (`/api…`) in-process, so MCP tools get the same auth, roles and validation. */
export type ApiFetch = (path: string, init: RequestInit) => Promise<Response>;

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const INSTRUCTIONS = `Zyrox is server-driven UI for React and React Native: screens are JSON documents rendered by the app's own registered components, published from a server.

Workflow:
1. list_projects, then use the project slug in every tool.
2. Learn the design system: create_design_system_rules (save it as a rules file), or list_components, get_component and get_variable_defs.
3. Build or change a screen: get_design_context → apply_ops (small edits, pass the revision) → fix every problem it returns → create_preview_link to check it on a device or the web app.
4. Missing a component? scaffold_component, implement and register it in the app's code, then upload_manifest (or \`npx zyrox manifest push\`).
5. Data: give every data source realistic "mock" data; list_functions and test_function show remote functions documents can call.
get_guide has the full guides (screens, components, data, backend-ui, i18n, releases, setup). Publishing and releasing are done by people in the dashboard.`;

const OPS_HELP = `Ops, applied in order and addressed by node id:
{ "op": "insert", "parent": id, "slot"?: "children" | "slots.<name>" | "templates.<name>" | "fallback", "index"?: n, "node": Node }
{ "op": "update", "id": id, "set"?: { "props.label": value, "if": "{{ expr }}", "on.press": [actions] }, "unset"?: ["props.tone"] }
{ "op": "remove", "id": id }
{ "op": "move", "id": id, "parent": id, "slot"?: …, "index"?: n }
{ "op": "doc", "set"?: { "title": "…", "state.qty": 1, "data.products": { "url": "/products", "mock": [] } }, "unset"?: […] }
{ "op": "replace", "document": Document } (only to build a screen from scratch)`;

const project = z.string().describe('Project slug (from list_projects)');
const documentKey = z.string().describe('Document key, e.g. "home" or "checkout/cart"');

interface DocumentResponse {
  document: { id: string; projectId: string; key: string; kind: string; title: string; description: string };
  draft: { content: Document; revision: number } | null;
  latest: { number: number; ref: string } | null;
  dirty: boolean;
}

interface ManifestRow {
  hash: string;
  label: string;
  latest: boolean;
  share: number;
  manifest: Manifest;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

function formatProblems(problems: Problem[]): string {
  if (!problems.length) return 'No problems.';
  return problems
    .map(
      (p) =>
        `- [${p.level}] ${p.code}${p.nodeId ? ` at #${p.nodeId}` : p.path ? ` at ${p.path}` : ''}: ${p.message}`,
    )
    .join('\n');
}

function typesIn(node: Node): Set<string> {
  return new Set(
    listNodes({ zyrox: 1, kind: 'screen', key: '', root: node } as Document).map((l) => l.node.type),
  );
}

function ancestry(doc: Document, id: string): string[] {
  const path: string[] = [];
  let current = findNode(doc, id);
  while (current) {
    path.unshift(current.node.id);
    current = current.parent ? findNode(doc, current.parent.id) : undefined;
  }
  return path;
}

function createServer(ctx: ServerContext, api: ApiFetch, authorization: string, origin: string): McpServer {
  const server = new McpServer({ name: 'zyrox', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await api(path, {
      method,
      headers: { authorization, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; details?: unknown };
    };
    if (!res.ok)
      throw new ApiError(data.error?.message ?? `HTTP ${res.status}`, res.status, data.error?.details);
    return data as T;
  }

  async function run(fn: () => Promise<string>): Promise<CallToolResult> {
    try {
      return { content: [{ type: 'text', text: await fn() }] };
    } catch (err) {
      let text = err instanceof Error ? err.message : String(err);
      if (err instanceof ApiError) {
        const problems = (err.details as { problems?: Problem[] } | undefined)?.problems;
        if (problems?.length) text += `\n${formatProblems(problems)}`;
        if (err.status === 409)
          text += '\nThe draft changed. Call get_design_context again and redo your edit.';
      }
      return { isError: true, content: [{ type: 'text', text }] };
    }
  }

  const getDocument = (p: string, key: string) =>
    call<DocumentResponse>('GET', `/projects/${p}/documents/${key}`);
  const manifests = async (p: string) =>
    (await call<{ manifests: ManifestRow[] }>('GET', `/projects/${p}/manifests`)).manifests;
  const latestManifest = async (p: string) => (await manifests(p))[0];
  const validate = (p: string, key: string, content?: unknown) =>
    call<{
      problems: Problem[];
      compat: { label: string; hash: string; share: number; problems: Problem[] }[];
    }>('POST', `/projects/${p}/documents/${key}/validate`, content === undefined ? {} : { content });

  /** Component name → keys of screens and blocks whose draft uses it. */
  async function usage(p: string): Promise<Map<string, string[]>> {
    const { documents } = await call<{ documents: { key: string; kind: string }[] }>(
      'GET',
      `/projects/${p}/documents`,
    );
    const keys = documents
      .filter((d) => d.kind !== 'strings')
      .map((d) => d.key)
      .slice(0, 300);
    const used = new Map<string, string[]>();
    for (let i = 0; i < keys.length; i += 10) {
      const batch = await Promise.all(keys.slice(i, i + 10).map((key) => getDocument(p, key)));
      for (const doc of batch) {
        if (!doc.draft?.content?.root) continue;
        for (const type of typesIn(doc.draft.content.root))
          used.set(type, [...(used.get(type) ?? []), doc.document.key]);
      }
    }
    return used;
  }

  // --- Guides ---------------------------------------------------------------------------------------

  const skills = listSkills();
  for (const skill of skills) {
    server.registerResource(
      skill.name,
      `zyrox://skills/${skill.name}`,
      { title: skill.name, description: skill.description, mimeType: 'text/markdown' },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: readSkill(skill.name) }],
      }),
    );
  }

  server.registerTool(
    'get_guide',
    {
      title: 'Read a Zyrox guide',
      description:
        'Returns a Zyrox guide (Agent Skill) in Markdown. Without a topic, lists the guides. Read "zyrox-screens" before designing screens and "zyrox-components" before writing components.',
      inputSchema: {
        topic: z
          .enum(skills.map((s) => s.name) as [string, ...string[]])
          .optional()
          .describe('Guide name'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ topic }) =>
      run(async () =>
        topic ? readSkill(topic) : skills.map((s) => `- ${s.name}: ${s.description}`).join('\n'),
      ),
  );

  // --- Projects and design system -----------------------------------------------------------------

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'Projects you can access, with your role in each.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const me = await call<{
          projects: { slug: string; name: string; role: string; defaultLocale: string }[];
        }>('GET', '/me');
        if (!me.projects.length) return 'No projects yet. Create one in the dashboard.';
        return me.projects
          .map((p) => `- ${p.slug}: ${p.name} (role: ${p.role}, default locale: ${p.defaultLocale})`)
          .join('\n');
      }),
  );

  server.registerTool(
    'list_components',
    {
      title: 'List components',
      description:
        "The app's registered components (from the latest app build manifest) with their props, events, slots and code location, plus app actions and helpers.",
      inputSchema: { project },
      annotations: { readOnlyHint: true },
    },
    ({ project: p }) =>
      run(async () => {
        const row = await latestManifest(p);
        if (!row)
          return 'No app manifest uploaded yet. Register components in the app, then run `npx zyrox manifest push` (see get_guide zyrox-components).';
        const m = row.manifest;
        const lines = [`App build ${row.label || row.hash} (${row.hash})`, '', '## Components'];
        for (const [name, c] of Object.entries(m.components)) {
          lines.push(
            `- ${componentSignature(name, c)}${c.description ? `\n  ${c.description}` : ''}${c.source ? `\n  code: ${c.source}` : ''}`,
          );
        }
        const actions = Object.entries(m.actions);
        if (actions.length) {
          lines.push('', '## App actions ({ "do": name, ...args })');
          for (const [name, a] of actions)
            lines.push(
              `- ${componentSignature(name, { props: a.args, events: {}, children: false, slots: [], templates: [] })}${a.description ? ` — ${a.description}` : ''}`,
            );
        }
        if (m.helpers.length) lines.push('', `App helpers: ${m.helpers.join(', ')}`);
        if (m.motions.length) lines.push(`Motions: ${m.motions.join(', ')}`);
        if (m.transitions.length) lines.push(`Transitions: ${m.transitions.join(', ')}`);
        return lines.join('\n');
      }),
  );

  server.registerTool(
    'get_component',
    {
      title: 'Get a component',
      description:
        'Full contract of one component: prop schema, events, slots, templates, binding, code location, which screens use it, which app builds have it, and an example node.',
      inputSchema: { project, name: z.string().describe('Component name, e.g. "ProductCard"') },
      annotations: { readOnlyHint: true },
    },
    ({ project: p, name }) =>
      run(async () => {
        const rows = await manifests(p);
        const c = rows[0]?.manifest.components[name];
        if (!c) {
          const known = Object.keys(rows[0]?.manifest.components ?? {});
          throw new Error(
            `"${name}" is not in the latest app build. Components: ${known.join(', ') || 'none'}`,
          );
        }
        const used = (await usage(p)).get(name) ?? [];
        const builds = rows.filter((r) => r.manifest.components[name]);
        const example: Node = {
          id: name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase(),
          type: name,
          props: Object.fromEntries(
            componentProps(c)
              .filter((prop) => prop.required)
              .map((prop) => [
                prop.name,
                prop.type.startsWith('number') ? 0 : prop.type === 'boolean' ? false : '…',
              ]),
          ),
          ...(c.children ? { children: [] } : {}),
        };
        return [
          `# ${name}`,
          c.description ?? '',
          c.source ? `Code: ${c.source}` : 'Code location unknown (add `source` to its defineComponent).',
          '',
          `Signature: ${componentSignature(name, c)}`,
          '',
          '## Props (JSON Schema)',
          json(c.props),
          Object.keys(c.events).length ? `\n## Events\n${json(c.events)}` : '',
          '',
          `## Used in (${used.length})`,
          used.length ? used.map((k) => `- ${k}`).join('\n') : 'Not used yet.',
          '',
          `## App builds with it: ${builds.length}/${rows.length} (${pct(builds.reduce((s, r) => s + r.share, 0))} of traffic)`,
          '',
          '## Example node',
          json(example),
        ]
          .filter((l) => l !== undefined)
          .join('\n');
      }),
  );

  server.registerTool(
    'get_component_map',
    {
      title: 'Component map',
      description:
        'Maps every component to its code location, the screens that use it, and its support across app builds in use (like a Code Connect map). Also flags component types used by documents but missing from the latest build.',
      inputSchema: { project },
      annotations: { readOnlyHint: true },
    },
    ({ project: p }) =>
      run(async () => {
        const rows = await manifests(p);
        const latest = rows[0];
        if (!latest) return 'No app manifest uploaded yet.';
        const used = await usage(p);
        const lines = [
          '| Component | Code | Used in | Builds with it (traffic) |',
          '| --- | --- | --- | --- |',
        ];
        for (const [name, c] of Object.entries(latest.manifest.components)) {
          const builds = rows.filter((r) => r.manifest.components[name]);
          const share = builds.reduce((s, r) => s + r.share, 0);
          const docs = used.get(name) ?? [];
          lines.push(
            `| ${name} | ${c.source ?? '—'} | ${docs.length ? docs.slice(0, 8).join(', ') + (docs.length > 8 ? ` +${docs.length - 8}` : '') : '—'} | ${builds.length}/${rows.length} (${pct(share)}) |`,
          );
        }
        const missing = [...used.keys()].filter(
          (t) => !latest.manifest.components[t] && !t.startsWith('@block/'),
        );
        if (missing.length)
          lines.push(
            '',
            `Used by documents but not in the latest build: ${missing.map((t) => `${t} (${used.get(t)!.join(', ')})`).join('; ')}`,
          );
        return lines.join('\n');
      }),
  );

  server.registerTool(
    'get_variable_defs',
    {
      title: 'Design tokens',
      description:
        'Design tokens from the app build (colors, spacing, type sizes…), plus motion presets and screen transitions. Documents pick tokens through enum props such as tone or size.',
      inputSchema: { project },
      annotations: { readOnlyHint: true },
    },
    ({ project: p }) =>
      run(async () => {
        const row = await latestManifest(p);
        if (!row) return 'No app manifest uploaded yet.';
        return json({
          tokens: row.manifest.tokens ?? {},
          motions: row.manifest.motions,
          transitions: row.manifest.transitions,
        });
      }),
  );

  server.registerTool(
    'create_design_system_rules',
    {
      title: 'Create design system rules',
      description:
        "Generates a Markdown rules file describing the app's components, tokens, actions and screen-building rules. Save it in the repository (e.g. .claude/rules/zyrox-design-system.md or AGENTS.md) so future work follows the design system.",
      inputSchema: { project },
      annotations: { readOnlyHint: true },
    },
    ({ project: p }) =>
      run(async () => {
        const [info, row, used] = await Promise.all([
          call<{ project: { name: string } }>('GET', `/projects/${p}`),
          latestManifest(p),
          usage(p),
        ]);
        return designSystemRules(row?.manifest, {
          project: info.project.name,
          label: row?.label,
          usage: Object.fromEntries([...used].map(([k, v]) => [k, v.length])),
        });
      }),
  );

  // --- Documents ------------------------------------------------------------------------------------

  server.registerTool(
    'list_documents',
    {
      title: 'List documents',
      description:
        'Screens, blocks and translation documents, with published version, live environments and unpublished changes.',
      inputSchema: { project, kind: z.enum(['screen', 'block', 'strings']).optional() },
      annotations: { readOnlyHint: true },
    },
    ({ project: p, kind }) =>
      run(async () => {
        const { documents } = await call<{
          documents: {
            key: string;
            kind: string;
            title: string;
            dirty: boolean;
            latest: { number: number } | null;
            live: Record<string, { number: number; rules: number }>;
          }[];
        }>('GET', `/projects/${p}/documents${kind ? `?kind=${kind}` : ''}`);
        if (!documents.length) return 'No documents yet. Create one with create_document.';
        return documents
          .map((d) => {
            const live = Object.entries(d.live).map(
              ([env, l]) => `${env} v${l.number}${l.rules ? ` +${l.rules} rules` : ''}`,
            );
            return `- ${d.key} (${d.kind})${d.title ? ` "${d.title}"` : ''} · ${d.latest ? `v${d.latest.number}` : 'never published'}${live.length ? ` · live: ${live.join(', ')}` : ''}${d.dirty ? ' · unpublished changes' : ''}`;
          })
          .join('\n');
      }),
  );

  server.registerTool(
    'get_design_context',
    {
      title: 'Get design context',
      description:
        'Everything needed to work on a screen or block: its draft JSON (or one node subtree), the components it uses with their signatures and code locations, params, state and data sources, the current revision, and validation problems. Call it before apply_ops.',
      inputSchema: {
        project,
        key: documentKey,
        node_id: z.string().optional().describe('Only this node and its subtree'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ project: p, key, node_id }) =>
      run(async () => {
        const [doc, row] = await Promise.all([getDocument(p, key), latestManifest(p)]);
        if (!doc.draft) throw new Error('This document has no draft');
        const content = doc.draft.content;
        const title = doc.document.title || (typeof content.title === 'string' ? content.title : '');
        const head = [
          `# ${doc.document.kind} "${doc.document.key}"${title ? ` — ${title}` : ''}`,
          doc.document.description || '',
          `Draft revision ${doc.draft.revision} (pass it to apply_ops) · ${doc.latest ? `published v${doc.latest.number}` : 'never published'}${doc.dirty ? ' · unpublished changes' : ''}`,
        ].filter(Boolean);
        if (doc.document.kind === 'strings') return `${head.join('\n')}\n\n${json(content)}`;

        let scope: Node = content.root;
        if (node_id) {
          const located = findNode(content, node_id);
          if (!located) throw new Error(`No node "${node_id}" in ${key}`);
          scope = located.node;
          head.push(
            `Node path: ${ancestry(content, node_id).join(' › ')} (in ${located.slot} of #${located.parent?.id ?? '—'})`,
          );
        }
        const components = [...typesIn(scope)].sort().map((type) => {
          const c = row?.manifest.components[type];
          if (type.startsWith('@block/')) return `- ${type}: block (inlined at publish)`;
          if (!c) return `- ${type}: NOT in the latest app build`;
          return `- ${componentSignature(type, c)}${c.description ? `\n  ${c.description}` : ''}${c.source ? `\n  code: ${c.source}` : ''}`;
        });
        const { problems } = await validate(p, key);
        const scoped = node_id
          ? problems.filter((pr) => !pr.nodeId || findNode({ ...content, root: scope }, pr.nodeId))
          : problems;
        const meta = node_id
          ? []
          : [
              content.params ? `## Params\n${json(content.params)}` : '',
              content.state ? `## State\n${json(content.state)}` : '',
              content.data ? `## Data sources\n${json(content.data)}` : '',
              content.forms ? `## Forms (validation rules)\n${json(content.forms)}` : '',
            ].filter(Boolean);
        return [
          ...head,
          '',
          `## Components used${row ? ` (app build ${row.label || row.hash})` : ' (no app manifest uploaded)'}`,
          ...components,
          '',
          ...meta,
          `## ${node_id ? `Node ${node_id}` : 'Document'}`,
          json(node_id ? scope : content),
          '',
          '## Problems',
          formatProblems(scoped),
        ].join('\n');
      }),
  );

  server.registerTool(
    'create_document',
    {
      title: 'Create a screen or block',
      description:
        'Creates a screen or block draft. Without content it starts from an empty container; build it up with apply_ops.',
      inputSchema: {
        project,
        key: z.string().describe('Key apps use to load it, e.g. "home" or "promo/summer"'),
        kind: z.enum(['screen', 'block']),
        title: z.string().optional(),
        content: z.record(z.string(), z.unknown()).optional().describe('A full document to start from'),
      },
    },
    ({ project: p, key, kind, title, content }) =>
      run(async () => {
        const created = await call<{ draft: { content: Document; revision: number } }>(
          'POST',
          `/projects/${p}/documents`,
          { key, kind, title: title ?? '', ...(content ? { content } : {}) },
        );
        const { problems } = await validate(p, key);
        return `Created ${kind} "${key}" (revision ${created.draft.revision}).\n${json(created.draft.content)}\n\n## Problems\n${formatProblems(problems)}`;
      }),
  );

  server.registerTool(
    'apply_ops',
    {
      title: 'Edit a document',
      description: `Applies ops to a screen or block draft and returns the problems found afterwards; fix them with more ops. Prefer small, targeted ops. ${OPS_HELP}`,
      inputSchema: {
        project,
        key: documentKey,
        ops: z.array(z.record(z.string(), z.unknown())).min(1).max(200),
        revision: z
          .number()
          .int()
          .optional()
          .describe('Draft revision from get_design_context; the edit fails if someone changed it since'),
        preview_session: z
          .string()
          .optional()
          .describe('Session id from create_preview_link: connected devices update immediately'),
      },
      annotations: { destructiveHint: false },
    },
    ({ project: p, key, ops, revision, preview_session }) =>
      run(async () => {
        const result = await call<{ draft: { content: Document; revision: number }; inverse: unknown[] }>(
          'POST',
          `/projects/${p}/documents/${key}/ops`,
          { ops, ...(revision === undefined ? {} : { revision }) },
        );
        const { problems } = await validate(p, key);
        let previewNote = '';
        if (preview_session) {
          const doc = await getDocument(p, key);
          previewNote = ctx.preview.publish(preview_session, doc.document.projectId, result.draft.content)
            ? `\nPreview updated on ${ctx.preview.devices(preview_session).length} device(s).`
            : '\nPreview session not found or expired; create a new one.';
        }
        return `Applied ${ops.length} op${ops.length === 1 ? '' : 's'}. Draft revision is now ${result.draft.revision}.${previewNote}\n\n## Problems\n${formatProblems(problems)}\n\nUndo with apply_ops: ${JSON.stringify(result.inverse)}`;
      }),
  );

  server.registerTool(
    'validate_document',
    {
      title: 'Validate a document',
      description:
        'Validates the draft against the latest app build and reports which app builds still in use would break, with their share of traffic.',
      inputSchema: { project, key: documentKey },
      annotations: { readOnlyHint: true },
    },
    ({ project: p, key }) =>
      run(async () => {
        const result = await validate(p, key);
        const compat = result.compat
          .filter((c) => c.problems.length)
          .map(
            (c) =>
              `- ${c.label || c.hash} (${pct(c.share)} of traffic): ${c.problems.map((x) => x.message).join('; ')}`,
          );
        return `## Problems\n${formatProblems(result.problems)}\n\n## Older app builds\n${compat.length ? `${compat.join('\n')}\nAdd a "fallback" node or wait until these builds are gone.` : 'All app builds in use support this document.'}`;
      }),
  );

  server.registerTool(
    'create_preview_link',
    {
      title: 'Preview on a device',
      description:
        'Starts a live preview of the draft. Returns a deep link (open it on a phone or simulator running the app) and a web link when the project has a preview URL. Pass the session id to apply_ops to update devices live.',
      inputSchema: {
        project,
        key: documentKey,
        scheme: z.string().optional().describe('The app\'s URL scheme, e.g. "myapp"'),
      },
    },
    ({ project: p, key, scheme }) =>
      run(async () => {
        const [info, doc] = await Promise.all([
          call<{ project: { id: string; previewUrl: string | null } }>('GET', `/projects/${p}`),
          getDocument(p, key),
        ]);
        const session = await call<{ id: string; token: string; expiresAt: number }>(
          'POST',
          `/projects/${p}/preview-sessions`,
          {},
        );
        if (doc.draft) ctx.preview.publish(session.id, info.project.id, doc.draft.content);
        const query = `server=${encodeURIComponent(origin)}&session=${session.id}&token=${session.token}`;
        const lines = [
          `Preview session ${session.id} (expires ${new Date(session.expiresAt).toISOString()}).`,
          `App link: ${scheme ?? '<your-app-scheme>'}://zyrox-preview?${query}`,
        ];
        if (info.project.previewUrl)
          lines.push(
            `Web link: ${new URL(info.project.previewUrl, origin).origin}/?zyrox-preview=1&${query}`,
          );
        lines.push(`Pass preview_session: "${session.id}" to apply_ops to update connected devices live.`);
        return lines.join('\n');
      }),
  );

  // --- Data -----------------------------------------------------------------------------------------

  server.registerTool(
    'list_functions',
    {
      title: 'List remote functions',
      description:
        'Remote functions documents can call with { "do": "call", "fn": name, "args": {…}, "into": "state path" }: code functions on the server and webhooks to your backend.',
      inputSchema: { project },
      annotations: { readOnlyHint: true },
    },
    ({ project: p }) =>
      run(async () => {
        const { functions } = await call<{
          functions: { name: string; kind: string; url?: string; enabled?: boolean }[];
        }>('GET', `/projects/${p}/functions`);
        if (!functions.length)
          return 'No remote functions. An admin can add webhooks under Functions in the dashboard.';
        return functions
          .map(
            (f) =>
              `- ${f.name} (${f.kind}${f.url ? ` → ${f.url}` : ''}${f.enabled === false ? ', disabled' : ''})`,
          )
          .join('\n');
      }),
  );

  server.registerTool(
    'test_function',
    {
      title: 'Test a remote function',
      description:
        'Calls a remote function with sample args and returns its result, to design screens and mocks around real data.',
      inputSchema: {
        project,
        name: z.string(),
        args: z.record(z.string(), z.unknown()).optional(),
        env: z.string().optional().describe('Environment key (default "dev")'),
      },
    },
    ({ project: p, name, args, env }) =>
      run(async () => {
        const result = await call<{ ok: boolean; result?: unknown; error?: string; durationMs?: number }>(
          'POST',
          `/projects/${p}/functions/${encodeURIComponent(name)}/test`,
          { args: args ?? {}, env },
        );
        if (!result.ok) throw new Error(`Function failed: ${result.error}`);
        const text = json(result.result);
        return `${result.durationMs} ms\n${text.length > 20_000 ? `${text.slice(0, 20_000)}\n… (truncated)` : text}`;
      }),
  );

  // --- Components in code ---------------------------------------------------------------------------

  server.registerTool(
    'scaffold_component',
    {
      title: 'Scaffold a component',
      description:
        "Generates a component definition (def.ts) and starter web and React Native implementations following Zyrox conventions. Write the files into the app, replace the placeholder markup with the app's own design system, register it, then upload_manifest. Props should be optional or defaulted; use enums for design tokens.",
      inputSchema: {
        project: project.optional().describe('Checks the name against the app build'),
        name: z.string().describe('PascalCase, e.g. "ProductCard"'),
        description: z.string().describe('What it is and when to use it (shown to editors and agents)'),
        props: z
          .record(
            z.string(),
            z.object({
              type: z.enum(PROP_TYPES as [string, ...string[]]),
              values: z.array(z.string()).optional().describe('For enum'),
              default: z.union([z.string(), z.number(), z.boolean(), z.array(z.unknown())]).optional(),
              optional: z.boolean().optional(),
              description: z.string().optional(),
            }),
          )
          .optional(),
        events: z.array(z.string()).optional().describe('e.g. ["press"]'),
        children: z.boolean().optional(),
        slots: z.array(z.string()).optional(),
        templates: z.array(z.string()).optional().describe('Item renderers for lists, e.g. ["item"]'),
        bind: z.object({ prop: z.string(), event: z.string() }).optional(),
        dir: z.string().optional().describe('Default "src/zyrox/components"'),
        platforms: z.array(z.enum(['web', 'native'])).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ project: p, ...spec }) =>
      run(async () => {
        if (p) {
          const row = await latestManifest(p);
          if (row?.manifest.components[spec.name])
            throw new Error(
              `"${spec.name}" already exists (${row.manifest.components[spec.name]!.source ?? 'location unknown'}). Extend it with extendComponent or pick a new name.`,
            );
        }
        const result = scaffoldComponent(spec as Parameters<typeof scaffoldComponent>[0]);
        return [
          ...result.files.map((f) => `### ${f.path}\n\`\`\`tsx\n${f.content}\`\`\``),
          '### Register',
          `\`\`\`ts\n${result.registration}\n\`\`\``,
          ...(result.notes.length ? [`Notes: ${result.notes.join(' ')}`] : []),
          'Next: write these files, adapt the markup to the design system, register, then upload the manifest (upload_manifest or `npx zyrox manifest push`).',
        ].join('\n\n');
      }),
  );

  server.registerTool(
    'upload_manifest',
    {
      title: 'Upload an app manifest',
      description:
        "Registers an app build's components with the server (the output of `npx zyrox manifest build`, or registry.manifest). The dashboard, validation and agents then know the new components.",
      inputSchema: {
        project,
        manifest: z.record(z.string(), z.unknown()),
        label: z.string().optional().describe('App version, e.g. "3.5.0"'),
      },
    },
    ({ project: p, manifest, label }) =>
      run(async () => {
        const result = await call<{ hash: string; components: number }>('POST', `/projects/${p}/manifests`, {
          manifest,
          label,
        });
        return `Uploaded ${result.hash} with ${result.components} components.`;
      }),
  );

  return server;
}

/** Model Context Protocol endpoint (streamable HTTP, stateless). Authenticate with a personal access token. */
export function mcpRoutes(ctx: ServerContext, api: ApiFetch) {
  const app = new Hono<AppEnv>();
  app.all('/', async (c) => {
    const authorization = c.req.header('authorization');
    const user = authorization ? await currentUser(ctx, undefined, authorization) : undefined;
    if (!user || !authorization) {
      return c.json(
        {
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message:
              'Unauthorized: send "Authorization: Bearer zyx_…" with a personal access token from the dashboard.',
          },
          id: null,
        },
        401,
      );
    }
    const origin = ctx.options.publicUrl ?? new URL(c.req.url).origin;
    const server = createServer(ctx, api, authorization, origin);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
  return app;
}
