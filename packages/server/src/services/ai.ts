import Anthropic from '@anthropic-ai/sdk';
import { applyOps, BUILTIN_HELPER_NAMES, OpError } from '@wishyor/zyrox-core';
import { type Problem, validateDocument } from '@wishyor/zyrox-core/validate';
import { BUILTIN_ACTIONS, type Document, type Manifest, type Op, opSchema, z } from '@wishyor/zyrox-protocol';

export interface AiOptions {
  apiKey?: string;
  /** Default `claude-opus-5-5`. */
  model?: string;
  /** Default `medium`. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Inject a client (tests, proxies). */
  client?: AiClient;
}

/** The part of the Anthropic SDK the assistant uses (so tests can provide a fake). */
export interface AiClient {
  beta: {
    messages: {
      stream(params: Anthropic.Beta.MessageCreateParamsStreaming): {
        on(event: 'text', listener: (delta: string) => void): unknown;
        finalMessage(): Promise<Anthropic.Beta.BetaMessage>;
      };
      create(params: Anthropic.Beta.MessageCreateParamsNonStreaming): Promise<Anthropic.Beta.BetaMessage>;
    };
  };
}

export const DEFAULT_MODEL = 'claude-opus-5-5';

/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set([
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-fable-5-1',
  'claude-sonnet-5-5',
]);

export function createAiClient(options: AiOptions): AiClient | undefined {
  if (options.client) return options.client;
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return undefined;
  return new Anthropic({ apiKey }) as unknown as AiClient;
}

function requestExtras(model: string): Partial<Anthropic.Beta.MessageCreateParamsStreaming> {
  // On a policy decline, the API retries on a fallback model inside the same call.
  return FALLBACK_MODELS.has(model)
    ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
    : {};
}

// --- Prompt ------------------------------------------------------------------------------------------

const PROTOCOL_GUIDE = `You edit server-driven UI documents for a Zyrox app. Apps render these documents with their own React / React Native components, listed in the catalog below. You change a document only through the apply_ops tool.

## Document
{ "zyrox": 1, "kind": "screen" | "block", "key": string, "title"?: string,
  "params"?: { name: { "type": "string"|"number"|"boolean", "required"?: bool, "default"?: value } },
  "state"?: { ...initial JSON state },
  "data"?: { key: { "url": string, "method"?: "GET"|..., "body"?: value, "refresh"?: ["mount"|"foreground"|seconds], "debounce"?: ms, "if"?: expr, "mock"?: sample JSON } },
  "forms"?: { name: { "show"?: "touched"|"submit", "fields": { "path.under.state.<name>": Rules } } },
  "root": Node }
Rules (values may be expressions; inside them "value" is the field value; { "value": x, "message": "..." } adds a message):
{ "required"?: true|message, "minLength"?, "maxLength"?, "min"?, "max"?, "pattern"?: regex, "email"?: true|message, "url"?: true|message,
  "oneOf"?: [...], "equals"?: value, "if"?: expr (conditional field), "rules"?: [{ "check": expr, "message": string }] }

## Node
{ "id": unique string, "type": a catalog component, "props"?: {...}, "children"?: Node[] (only if the component has children),
  "slots"?: { name: Node[] }, "templates"?: { name: Node } (item rendered per element, with {{ item }} and {{ index }}),
  "on"?: { event: Action[] }, "bind"?: state path (two-way, only for bindable components),
  "if"?: expr, "repeat"?: { "each": expr, "as"?: name, "key"?: expr }, "with"?: { name: expr },
  "fallback"?: Node, "a11y"?: { "label"?, "hint"?, "role"? }, "motion"?: { "enter"?, "exit"?, "layout"? } }

## Values and expressions
Any string value may contain {{ expression }}. A string that is exactly "{{ expr }}" keeps the expression's type.
Expressions are a safe JavaScript subset: literals, a.b, a[b], arithmetic, comparisons (== is strict), && || ?? !, ternary, arrays, objects, and helper calls.
Scope: state, data, loading, error, params, app, device (width, height, platform, colorScheme, locale, direction), i18n (locale, direction), forms (forms.<name>.valid, .errors.<field>, .shown.<field>, .submitted), item/index in templates and repeats, event inside actions.
Helpers: ${BUILTIN_HELPER_NAMES.join(', ')}. t('key', { vars }) translates.

## Actions (run in order)
Built-in: ${BUILTIN_ACTIONS.join(', ')}.
- setState { path, value }  (path relative to state, e.g. "form.email")
- navigate { to, params?, presentation?: push|replace|modal|sheet|reset, transition? }, back { result? }, openUrl { url }
- request { url, method?, body?, into?, onSuccess?, onError? }  (event = response / { message })
- call { fn, args?, into?, onSuccess?, onError? }  (remote function)
- refresh { data? }, track { event, props? }, setLocale { locale }, if { cond, then?, else? }
- validate { form } (shows all errors, stops the list while invalid), resetForm { form, values? }, setErrors { form, errors } (e.g. "{{ event.body.errors }}" in onError)
- sheet { screen | document | content: { title?, message?, image?, buttons? }, params?, title?, size?: auto|half|full, dismissible?, id?, onClose? }, closeSheet { id?, result? }
- alert { title, message?, buttons?: [{ label, style?: default|primary|cancel|destructive, actions? }] } (waits for a button), toast { message, tone?: info|success|warning|danger, duration?, action?: { label, actions } }
- The app's own actions from the catalog, with their args.

## Ops (apply_ops takes a JSON array)
{ "op": "insert", "parent": id, "slot"?: "children" | "slots.<name>" | "templates.<name>" | "fallback", "index"?: n, "node": Node }
{ "op": "update", "id": id, "set"?: { "props.label": value, "if": expr, "on.press": [...] }, "unset"?: ["props.x"] }
{ "op": "remove", "id": id }
{ "op": "move", "id": id, "parent": id, "slot"?: ..., "index"?: n }
{ "op": "doc", "set"?: { "state.qty": 1, "data.products": {...}, "title": "..." }, "unset"?: [...] }
{ "op": "replace", "document": Document }  (only for building a screen from scratch)

## Rules
- Use only components, props, events, slots, templates and actions from the catalog. Respect each prop schema (enums, types, required props).
- Keep existing ids; give new nodes short, readable, unique ids (e.g. "hero-title").
- Prefer small, targeted ops over replacing the document.
- Use templates (not many copies) for lists of data. Give every data source realistic "mock" data so the preview works.
- Put user-facing copy in props directly unless the document already uses t().
- For input forms, declare rules in "forms" (not hand-written error expressions): bound fields get "error" and "required" automatically. Start submit actions with validate and send API field errors to setErrors.
- After apply_ops, fix every problem it reports. When done, reply with one or two sentences describing what changed.`;

function catalog(manifest: Manifest | undefined): string {
  if (!manifest)
    return 'No app manifest has been uploaded. Use only generic container and text components already present in the document.';
  return JSON.stringify(
    {
      components: manifest.components,
      actions: manifest.actions,
      helpers: manifest.helpers,
      motions: manifest.motions,
      transitions: manifest.transitions,
    },
    null,
    0,
  );
}

const TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  {
    name: 'apply_ops',
    description:
      'Apply edits to the current document. Returns the problems found afterwards, which you must fix.',
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        ops_json: {
          type: 'string',
          description: 'A JSON array of ops, e.g. [{"op":"update","id":"title","set":{"props.text":"Hi"}}]',
        },
        summary: { type: 'string', description: 'A few words describing this change' },
      },
      required: ['ops_json', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_document',
    description: 'Return the current document JSON (after the edits applied so far).',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
];

// --- Assistant loop -------------------------------------------------------------------------------------

export type AssistantEvent =
  | { type: 'text'; text: string }
  | { type: 'ops'; ops: Op[]; summary: string }
  | { type: 'problems'; problems: Problem[] }
  | { type: 'done'; document: Document }
  | { type: 'error'; message: string };

export interface AssistantRequest {
  client: AiClient;
  model?: string;
  effort?: AiOptions['effort'];
  manifest?: Manifest;
  document: Document;
  prompt: string;
  /** A screenshot or mockup to build from (base64). */
  image?: { mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string };
  onEvent(event: AssistantEvent): void;
  maxTurns?: number;
  signal?: AbortSignal;
}

const opsInput = z.object({ ops_json: z.string(), summary: z.string() });

function errorsOf(doc: Document, manifest: Manifest | undefined): Problem[] {
  return validateDocument(doc, { manifest, globals: doc.kind === 'block' ? ['input'] : [] }).filter(
    (p) => p.level === 'error' && !p.message.startsWith('No published block'),
  );
}

/**
 * Lets Claude edit a document with ops. Every op is validated and applied to a working copy;
 * problems are reported back so the model fixes them. Events stream to the caller.
 */
export async function runAssistant(request: AssistantRequest): Promise<Document> {
  const model = request.model ?? DEFAULT_MODEL;
  let doc = request.document;
  const userContent: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (request.image) {
    userContent.push({
      type: 'image',
      source: { type: 'base64', media_type: request.image.mediaType, data: request.image.data },
    });
  }
  userContent.push({
    type: 'text',
    text: `Current document:\n${JSON.stringify(doc)}\n\nRequest: ${request.prompt}`,
  });
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: userContent }];
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: 'text', text: PROTOCOL_GUIDE },
    // The catalog only changes when the app uploads a new manifest: cache it.
    { type: 'text', text: `## Catalog\n${catalog(request.manifest)}`, cache_control: { type: 'ephemeral' } },
  ];

  for (let turn = 0; turn < (request.maxTurns ?? 12); turn++) {
    if (request.signal?.aborted) throw new Error('Cancelled');
    const stream = request.client.beta.messages.stream({
      model,
      max_tokens: 32000,
      system,
      tools: TOOLS,
      messages,
      thinking: { type: 'adaptive' },
      output_config: { effort: request.effort ?? 'medium' },
      ...requestExtras(model),
    } as Anthropic.Beta.MessageCreateParamsStreaming);
    stream.on('text', (text) => request.onEvent({ type: 'text', text }));
    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await stream.finalMessage();
    } catch (err) {
      // An unparseable streamed tool input: re-issue the turn. API errors propagate.
      if (err instanceof Anthropic.APIError) throw err;
      continue;
    }
    if (message.stop_reason === 'refusal') throw new Error('The assistant declined this request.');
    if (message.stop_reason === 'max_tokens')
      throw new Error('The response was too long. Try a smaller request.');
    if (message.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: message.content });
      continue;
    }
    const toolUses = message.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
    );
    if (!toolUses.length) break;
    messages.push({ role: 'assistant', content: message.content });

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of toolUses) {
      if (use.name === 'get_document') {
        results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(doc) });
        continue;
      }
      const input = opsInput.safeParse(use.input);
      if (use.name !== 'apply_ops' || !input.success) {
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          is_error: true,
          content: 'Invalid tool input. Send { "ops_json": "[...]", "summary": "..." }.',
        });
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(input.data.ops_json);
      } catch (err) {
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          is_error: true,
          content: `ops_json is not valid JSON: ${(err as Error).message}`,
        });
        continue;
      }
      const ops = z.array(opSchema).safeParse(Array.isArray(raw) ? raw : [raw]);
      if (!ops.success) {
        const issue = ops.error.issues[0];
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          is_error: true,
          content: `Invalid op at ${issue?.path.join('.')}: ${issue?.message}`,
        });
        continue;
      }
      try {
        doc = applyOps(doc, ops.data).doc;
      } catch (err) {
        const message = err instanceof OpError ? err.message : String(err);
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          is_error: true,
          content: `Not applied: ${message}`,
        });
        continue;
      }
      request.onEvent({ type: 'ops', ops: ops.data, summary: input.data.summary });
      const problems = errorsOf(doc, request.manifest);
      request.onEvent({ type: 'problems', problems });
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: problems.length
          ? `Applied. Fix these problems:\n${problems.map((p) => `- ${p.nodeId ? `#${p.nodeId} ` : ''}${p.message}${p.path ? ` (${p.path})` : ''}`).join('\n')}`
          : 'Applied. No problems.',
      });
    }
    messages.push({ role: 'user', content: results });
  }
  request.onEvent({ type: 'done', document: doc });
  return doc;
}

// --- Translations ---------------------------------------------------------------------------------------

/** Translates messages with structured output: exactly the given keys come back. */
export async function translateMessages(options: {
  client: AiClient;
  model?: string;
  sourceLocale: string;
  locale: string;
  messages: Record<string, string>;
  context?: string;
}): Promise<Record<string, string>> {
  const keys = Object.keys(options.messages);
  if (!keys.length) return {};
  const model = options.model ?? DEFAULT_MODEL;
  const response = await options.client.beta.messages.create({
    model,
    max_tokens: 16000,
    output_config: {
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: Object.fromEntries(keys.map((k) => [k, { type: 'string' }])),
          required: keys,
          additionalProperties: false,
        },
      },
    },
    system:
      'You translate app UI strings. Keep placeholders like {name} and ICU syntax such as {count, plural, one {# item} other {# items}} intact (translate only the human text inside branches). Match the tone and length of the source. Return only the JSON object.',
    messages: [
      {
        role: 'user',
        content: `Translate from ${options.sourceLocale} to ${options.locale}.${options.context ? ` App context: ${options.context}.` : ''}\n${JSON.stringify(options.messages)}`,
      },
    ],
    ...requestExtras(model),
  } as Anthropic.Beta.MessageCreateParamsNonStreaming);
  if (response.stop_reason === 'refusal') throw new Error('The translation was declined.');
  const text =
    response.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')?.text ?? '{}';
  const parsed = JSON.parse(text) as Record<string, unknown>;
  return Object.fromEntries(
    keys.filter((k) => typeof parsed[k] === 'string').map((k) => [k, parsed[k] as string]),
  );
}
