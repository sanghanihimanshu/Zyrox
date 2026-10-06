import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildManifest, type Document } from '@zyrox/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import counterJson from '../../../examples/components/documents/counter.json';
import { exampleManifestInput } from '../../../examples/components/src/manifest';
import { createZyroxServer, type ZyroxServer } from '../src';

const manifest = buildManifest(exampleManifestInput);
let server: ZyroxServer;
let listening: { port: number; close(): Promise<void> };
let token = '';
let mcp: Client;

async function api(method: string, path: string, body?: unknown) {
  const res = await server.app.request(path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function tool(name: string, args: Record<string, unknown>) {
  const result = (await mcp.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  return { isError: Boolean(result.isError), text: result.content.map((c) => c.text).join('\n') };
}

beforeAll(async () => {
  server = await createZyroxServer({ database: 'memory://', counterIntervalMs: 0, ai: false });
  const signup = await server.app.request('/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ada@example.com', password: 'correct horse', name: 'Ada' }),
  });
  const cookie = signup.headers.get('set-cookie')!.split(';')[0]!;
  const created = await server.app.request('/api/tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'agent' }),
  });
  token = ((await created.json()) as { token: string }).token;
  await api('POST', '/api/projects', { name: 'Shop', slug: 'shop' });
  await api('POST', '/api/projects/shop/manifests', { manifest, label: '1.0.0' });
  await api('POST', '/api/projects/shop/documents', { key: 'counter', kind: 'screen', content: counterJson });

  listening = await server.listen(0, '127.0.0.1');
  mcp = new Client({ name: 'test', version: '1.0.0' });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${listening.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
});

afterAll(async () => {
  await mcp?.close();
  await listening?.close();
  await server?.close();
});

describe('MCP endpoint', () => {
  it('rejects requests without a token', async () => {
    const res = await server.app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
      /personal access token/,
    );
  });

  it('lists design tools and guide resources, with instructions', async () => {
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'apply_ops',
      'create_design_system_rules',
      'create_document',
      'create_preview_link',
      'get_component',
      'get_component_map',
      'get_design_context',
      'get_guide',
      'get_variable_defs',
      'list_components',
      'list_documents',
      'list_functions',
      'list_projects',
      'scaffold_component',
      'test_function',
      'upload_manifest',
      'validate_document',
    ]);
    expect(tools.find((t) => t.name === 'get_design_context')?.annotations?.readOnlyHint).toBe(true);
    expect(mcp.getInstructions()).toMatch(/get_design_context → apply_ops/);
    const { resources } = await mcp.listResources();
    expect(resources.map((r) => r.uri)).toContain('zyrox://skills/zyrox-screens');
    const guide = await mcp.readResource({ uri: 'zyrox://skills/zyrox-components' });
    expect((guide.contents[0] as { text: string }).text).toContain('# Components for Zyrox');
    expect((await tool('get_guide', {})).text).toContain('- zyrox-data:');
  });

  it('describes the design system like a design-tool MCP', async () => {
    expect((await tool('list_projects', {})).text).toBe('- shop: Shop (role: admin, default locale: en)');
    const components = (await tool('list_components', { project: 'shop' })).text;
    expect(components).toContain('App build 1.0.0');
    expect(components).toContain(
      '- Button(label: string, variant?: "primary" | "secondary" | "ghost" = "primary", disabled?: boolean = false, loading?: boolean = false) events: press',
    );
    expect(components).toContain('code: examples/components/src/{web,native}/components.tsx#Button');

    const button = (await tool('get_component', { project: 'shop', name: 'Button' })).text;
    expect(button).toContain('## Used in (1)\n- counter');
    expect(button).toContain('App builds with it: 1/1');
    expect(button).toContain('"type": "Button"');
    expect((await tool('get_component', { project: 'shop', name: 'Nope' })).isError).toBe(true);

    const map = (await tool('get_component_map', { project: 'shop' })).text;
    expect(map).toContain(
      '| Badge | examples/components/src/{web,native}/components.tsx#Badge | counter | 1/1 (0%) |',
    );

    const vars = JSON.parse((await tool('get_variable_defs', { project: 'shop' })).text);
    expect(vars.tokens.space.md).toBe(16);
    expect(vars.transitions).toEqual(['fade', 'slide']);

    const rules = (await tool('create_design_system_rules', { project: 'shop' })).text;
    expect(rules).toMatch(/^# Shop design system rules \(Zyrox\)/);
    expect(rules).toContain('### Button');
  });

  it('gives design context and edits with ops', async () => {
    const context = (await tool('get_design_context', { project: 'shop', key: 'counter' })).text;
    expect(context).toContain('# screen "counter" — Counter');
    expect(context).toContain('Draft revision 1');
    expect(context).toContain('## State\n{\n  "count": 0\n}');
    expect(context).toContain('No problems.');
    const node = (await tool('get_design_context', { project: 'shop', key: 'counter', node_id: 'inc' })).text;
    expect(node).toContain('Node path: root › row › inc');
    expect(node).not.toContain('- Stack(');

    const bad = await tool('apply_ops', {
      project: 'shop',
      key: 'counter',
      revision: 1,
      ops: [{ op: 'insert', parent: 'row', node: { id: 'x', type: 'Sparkles' } }],
    });
    expect(bad.text).toContain('Draft revision is now 2');
    expect(bad.text).toMatch(/\[error\] unknown_component at #x/);
    const stale = await tool('apply_ops', {
      project: 'shop',
      key: 'counter',
      revision: 1,
      ops: [{ op: 'remove', id: 'x' }],
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain('Call get_design_context again');
    const fixed = await tool('apply_ops', {
      project: 'shop',
      key: 'counter',
      ops: [{ op: 'remove', id: 'x' }],
    });
    expect(fixed.text).toContain('No problems.');
    expect(
      (await tool('apply_ops', { project: 'shop', key: 'counter', ops: [{ op: 'remove', id: 'ghost' }] }))
        .isError,
    ).toBe(true);

    const validated = (await tool('validate_document', { project: 'shop', key: 'counter' })).text;
    expect(validated).toContain('All app builds in use support this document.');

    const created = await tool('create_document', {
      project: 'shop',
      key: 'promo',
      kind: 'block',
      title: 'Promo',
    });
    expect(created.text).toContain('Created block "promo"');
    expect((await tool('list_documents', { project: 'shop' })).text).toContain(
      '- promo (block) "Promo" · never published',
    );
  });

  it('streams agent edits to devices through a preview link', async () => {
    const link = (await tool('create_preview_link', { project: 'shop', key: 'counter', scheme: 'shop' }))
      .text;
    const match = /shop:\/\/zyrox-preview\?server=([^&]+)&session=([^&]+)&token=(\S+)/.exec(link);
    expect(match).not.toBeNull();
    const [, origin, session, previewToken] = match!;
    expect(decodeURIComponent(origin!)).toBe(`http://127.0.0.1:${listening.port}`);
    const messages: { type: string; document: Document }[] = [];
    const device = new WebSocket(
      `ws://127.0.0.1:${listening.port}/v1/preview/${session}?token=${previewToken}`,
    );
    device.on('message', (data) => messages.push(JSON.parse(String(data))));
    await new Promise((resolve) => device.on('open', resolve));
    const waitFor = async (predicate: (d: Document) => boolean) => {
      for (let i = 0; i < 100 && !messages.some((m) => predicate(m.document)); i++)
        await new Promise((r) => setTimeout(r, 20));
      return messages.some((m) => predicate(m.document));
    };
    expect(await waitFor((d) => d.key === 'counter')).toBe(true);
    const edit = await tool('apply_ops', {
      project: 'shop',
      key: 'counter',
      preview_session: session,
      ops: [{ op: 'update', id: 'inc', set: { 'props.label': 'Add' } }],
    });
    expect(edit.text).toContain('Preview updated on 1 device(s).');
    expect(await waitFor((d) => JSON.stringify(d).includes('"label":"Add"'))).toBe(true);
    device.close();
  });

  it('scaffolds components and uploads manifests', async () => {
    const taken = await tool('scaffold_component', { project: 'shop', name: 'Button', description: 'x' });
    expect(taken.isError).toBe(true);
    expect(taken.text).toContain('already exists');
    const scaffold = await tool('scaffold_component', {
      project: 'shop',
      name: 'Rating',
      description: 'Star rating input.',
      props: { value: { type: 'integer', default: 0 }, max: { type: 'integer', default: 5 } },
      bind: { prop: 'value', event: 'change' },
    });
    expect(scaffold.text).toContain('### src/zyrox/components/rating/def.ts');
    expect(scaffold.text).toContain('### src/zyrox/components/rating/Rating.native.tsx');
    expect((await tool('scaffold_component', { name: 'bad name', description: 'x' })).text).toContain(
      'PascalCase',
    );

    const next = buildManifest({ ...exampleManifestInput, helpers: ['stars'] });
    expect((await tool('upload_manifest', { project: 'shop', manifest: next, label: '1.1.0' })).text).toBe(
      `Uploaded ${next.hash} with ${Object.keys(next.components).length} components.`,
    );
    expect(
      (await tool('upload_manifest', { project: 'shop', manifest: { ...next, hash: 'm_x' } })).isError,
    ).toBe(true);
    expect((await tool('list_components', { project: 'shop' })).text).toContain('App helpers: stars');
  });

  it('enforces project roles', async () => {
    expect((await tool('list_components', { project: 'other' })).text).toBe('Project not found');
    expect((await tool('list_functions', { project: 'shop' })).text).toContain('No remote functions');
  });
});
