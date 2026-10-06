import type Anthropic from '@anthropic-ai/sdk';
import { buildManifest, type Document } from '@zyrox/protocol';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import counterJson from '../../../examples/components/documents/counter.json';
import { exampleManifestInput } from '../../../examples/components/src/manifest';
import { createZyroxServer, type TranslationProvider, type ZyroxServer } from '../src';
import { type AiClient, type AssistantEvent, runAssistant } from '../src/services/ai';
import {
  deeplTranslator,
  libreTranslator,
  textTranslator,
  webhookTranslator,
} from '../src/services/translation';

const manifest = buildManifest(exampleManifestInput);
const counter = counterJson as unknown as Document;

type Block = Anthropic.Beta.BetaContentBlock;
const message = (content: Block[], stop_reason: string = 'tool_use') =>
  ({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'm',
    content,
    stop_reason,
    usage: {},
  }) as unknown as Anthropic.Beta.BetaMessage;
const applyOps = (id: string, ops: unknown[]) =>
  ({
    type: 'tool_use',
    id,
    name: 'apply_ops',
    input: { ops_json: JSON.stringify(ops), summary: 'edit' },
  }) as Block;
const text = (t: string) => ({ type: 'text', text: t, citations: null }) as Block;

/** A scripted stand-in for the Anthropic SDK. */
function fakeClient(turns: Anthropic.Beta.BetaMessage[], created: Anthropic.Beta.BetaMessage[] = []) {
  const streamed: Anthropic.Beta.MessageCreateParamsStreaming[] = [];
  const requests: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  const client: AiClient = {
    beta: {
      messages: {
        stream(params) {
          streamed.push(structuredClone(params));
          const next = turns.shift();
          const listeners: ((delta: string) => void)[] = [];
          return {
            on(_event: 'text', listener: (delta: string) => void) {
              listeners.push(listener);
              return this;
            },
            async finalMessage() {
              if (!next) throw new Error('no more turns');
              for (const block of next.content)
                if (block.type === 'text') for (const l of listeners) l(block.text);
              return next;
            },
          };
        },
        async create(params) {
          requests.push(params);
          return created.shift()!;
        },
      },
    },
  };
  return { client, streamed, requests };
}

describe('AI assistant', () => {
  it('edits with validated ops, reports problems back, and streams events', async () => {
    const { client, streamed } = fakeClient([
      message([
        text('Adding a badge.'),
        applyOps('t1', [{ op: 'insert', parent: 'root', node: { id: 'new', type: 'Sparkle' } }]),
      ]),
      message([applyOps('t2', [{ op: 'update', id: 'new', set: { type: 'Badge', 'props.label': 'New' } }])]),
      message([
        applyOps('t3', [{ op: 'remove', id: 'ghost' }]),
        { type: 'tool_use', id: 't4', name: 'get_document', input: {} } as Block,
      ]),
      message([text('Done: added a "New" badge.')], 'end_turn'),
    ]);
    const events: AssistantEvent[] = [];
    const result = await runAssistant({
      client,
      manifest,
      document: counter,
      prompt: 'Add a "New" badge',
      image: { mediaType: 'image/png', data: 'iVBORw0KGgo=' },
      onEvent: (e) => events.push(e),
    });
    expect(result.root.children?.at(-1)).toMatchObject({ id: 'new', type: 'Badge', props: { label: 'New' } });
    expect(events.map((e) => e.type)).toEqual(['text', 'ops', 'problems', 'ops', 'problems', 'text', 'done']);
    expect(events[2]).toMatchObject({
      type: 'problems',
      problems: [{ code: 'unknown_component', nodeId: 'new' }],
    });
    expect(events[4]).toMatchObject({ type: 'problems', problems: [] });

    const first = streamed[0]!;
    expect(first).toMatchObject({
      model: 'claude-opus-5-5',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    expect((first.system as Anthropic.Beta.BetaTextBlockParam[])[1]!.cache_control).toEqual({
      type: 'ephemeral',
    });
    expect((first.messages[0]!.content as Anthropic.Beta.BetaContentBlockParam[])[0]).toMatchObject({
      type: 'image',
    });
    expect(first.tools?.map((t) => (t as { name: string }).name)).toEqual(['apply_ops', 'get_document']);
    // Problems and op errors go back to the model as tool results.
    const results = (turn: number) =>
      streamed[turn]!.messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(results(1)[0]!.content).toContain('Fix these problems');
    expect(results(3)[0]).toMatchObject({ is_error: true, content: expect.stringContaining('Not applied') });
    expect(JSON.parse(results(3)[1]!.content as string).root.id).toBe('root');
  });

  it('stops on refusals and rejects malformed ops', async () => {
    const refused = fakeClient([message([], 'refusal')]);
    await expect(
      runAssistant({ client: refused.client, document: counter, prompt: 'x', onEvent: () => {} }),
    ).rejects.toThrow('declined');

    const { client, streamed } = fakeClient([
      message([
        {
          type: 'tool_use',
          id: 'a',
          name: 'apply_ops',
          input: { ops_json: 'not json', summary: 's' },
        } as Block,
        applyOps('b', [{ op: 'explode' }]),
      ]),
      message([text('ok')], 'end_turn'),
    ]);
    await runAssistant({ client, model: 'my-model', document: counter, prompt: 'x', onEvent: () => {} });
    const results = streamed[1]!.messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(results.map((r) => r.is_error)).toEqual([true, true]);
    expect(results[0]!.content).toContain('not valid JSON');
    expect(streamed[0]).not.toHaveProperty('fallbacks');
  });
});

describe('translation providers', () => {
  it('adapts plain-text models without breaking placeholders or plurals', async () => {
    const seen: string[][] = [];
    const provider = textTranslator('upper', async (texts) => {
      seen.push(texts);
      return texts.map((t) => (t === 'Bye' ? 'ADIEU {9}' : t.toUpperCase()));
    });
    const result = await provider.translate({
      sourceLocale: 'en',
      locale: 'fr',
      messages: {
        hi: 'Hello {name}',
        items: '{count, plural, one {# item} other {# items}}',
        same: 'Hello {name}',
        bye: 'Bye',
      },
    });
    expect(result).toEqual({
      hi: 'HELLO {name}',
      same: 'HELLO {name}',
      items: '{count, plural, one {# ITEM} other {# ITEMS}}',
    });
    expect(seen).toEqual([['Hello {0}', '{0} item', '{0} items', 'Bye']]);
  });

  it('calls DeepL, LibreTranslate and webhooks with their request shapes', async () => {
    const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url: String(url), body, headers: init?.headers as Record<string, string> });
      if (String(url).includes('deepl'))
        return Response.json({ translations: body.text.map((t: string) => ({ text: `de:${t}` })) });
      if (String(url).includes('libre'))
        return Response.json({ translatedText: body.q.map((t: string) => `es:${t}`) });
      return Response.json({ messages: { a: 'hooked' } });
    }) as unknown as typeof globalThis.fetch;
    const request = { sourceLocale: 'en-US', locale: 'pt-BR', messages: { a: 'Hi {name}' } };
    expect(await deeplTranslator({ apiKey: 'k:fx', fetch }).translate(request)).toEqual({
      a: 'de:Hi {name}',
    });
    expect(calls[0]).toMatchObject({
      url: 'https://api-free.deepl.com/v2/translate',
      body: { text: ['Hi {0}'], source_lang: 'EN', target_lang: 'PT-BR' },
      headers: { authorization: 'DeepL-Auth-Key k:fx' },
    });
    expect(
      await libreTranslator({ url: 'http://libre:5000/', apiKey: 'x', fetch }).translate(request),
    ).toEqual({
      a: 'es:Hi {name}',
    });
    expect(calls[1]).toMatchObject({
      url: 'http://libre:5000/translate',
      body: { q: ['Hi {0}'], source: 'en', target: 'pt', format: 'text', api_key: 'x' },
    });
    expect(
      await webhookTranslator({ url: 'https://mt.example.com', token: 't', fetch }).translate(request),
    ).toEqual({
      a: 'hooked',
    });
    expect(calls[2]).toMatchObject({ body: request, headers: { authorization: 'Bearer t' } });
  });
});

describe('translation endpoints', () => {
  let server: ZyroxServer;
  let cookie = '';
  let devKey = '';
  const translate = vi.fn<TranslationProvider['translate']>(async ({ messages, locale }) =>
    Object.fromEntries(
      Object.entries(messages).map(([k, v]) => [k, k === 'broken' ? 'cassé' : `${locale}:${v}`]),
    ),
  );

  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await server.app.request(path, {
      method,
      headers: { 'content-type': 'application/json', cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  beforeAll(async () => {
    server = await createZyroxServer({
      database: 'memory://',
      counterIntervalMs: 0,
      ai: false,
      translator: { name: 'test-mt', translate },
      runtimeTranslation: true,
    });
    const signup = await server.app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ada@example.com', password: 'correct horse' }),
    });
    cookie = signup.headers.get('set-cookie')!.split(';')[0]!;
    const project = await api('POST', '/api/projects', { name: 'Shop', slug: 'shop' });
    devKey = project.body.environments.find((e: { key: string }) => e.key === 'dev').publicKey;
    await api('POST', '/api/projects/shop/documents', {
      key: 'strings/en',
      kind: 'strings',
      content: {
        zyrox: 1,
        kind: 'strings',
        locale: 'en',
        messages: { hi: 'Hello {name}', bye: 'Bye', broken: 'Hi {name}' },
      },
    });
    await api('POST', '/api/projects/shop/documents/strings/en/publish', { release: ['dev'] });
  });

  afterAll(() => server?.close());

  it('reports the provider and translates for editors, dropping broken results', async () => {
    expect((await api('GET', '/api/ai/status')).body).toEqual({
      enabled: false,
      model: null,
      translation: { provider: 'test-mt', runtime: true },
    });
    const res = await api('POST', '/api/projects/shop/translate', {
      sourceLocale: 'en',
      locale: 'fr',
      messages: { hi: 'Hello {name}', broken: 'Hi {name}' },
    });
    expect(res.body).toEqual({ messages: { hi: 'fr:Hello {name}' }, provider: 'test-mt' });
  });

  it('translates released source strings at runtime, by key only, with caching', async () => {
    translate.mockClear();
    const client = { authorization: `Bearer ${devKey}` };
    const boot = await api('GET', '/v1/bootstrap', undefined, client);
    expect(boot.body.strings.translate).toBe(true);
    const first = await api(
      'POST',
      '/v1/translate',
      { locale: 'de', keys: ['hi', 'bye', 'nope', 'broken'] },
      client,
    );
    expect(first.body).toEqual({ messages: { hi: 'de:Hello {name}', bye: 'de:Bye' } });
    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate.mock.calls[0]![0].messages).toEqual({
      broken: 'Hi {name}',
      bye: 'Bye',
      hi: 'Hello {name}',
    });
    const again = await api('POST', '/v1/translate', { locale: 'de', keys: ['hi'] }, client);
    expect(again.body.messages).toEqual({ hi: 'de:Hello {name}' });
    expect(translate).toHaveBeenCalledTimes(1);
    expect((await api('POST', '/v1/translate', { locale: 'en', keys: ['hi'] }, client)).body).toEqual({
      messages: {},
    });
    expect((await api('POST', '/v1/translate', { locale: 'de', keys: ['hi'] })).status).toBe(401);
  });
});
