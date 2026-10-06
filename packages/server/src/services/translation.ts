import { messageArgs, splitMessage } from '@wishyor/zyrox-core';
import { type AiClient, translateMessages } from './ai';

export interface TranslationRequest {
  sourceLocale: string;
  locale: string;
  /** Key → source text (ICU message syntax). */
  messages: Record<string, string>;
  /** What the app is about, for tone (models that take context). */
  context?: string;
}

/**
 * Any translation model or service. Return translated messages by key; leave out keys you
 * could not translate. Results whose placeholders differ from the source are discarded.
 */
export interface TranslationProvider {
  /** Shown in the dashboard, e.g. `deepl`. */
  name: string;
  translate(request: TranslationRequest): Promise<Record<string, string>>;
}

/** Plain-text machine translation: one string in, one string out, same order. */
export type TextTranslate = (
  texts: string[],
  request: { sourceLocale: string; locale: string },
) => Promise<string[]>;

/** Keeps translations whose placeholders and plural/select arguments match their source. */
export function checkTranslations(
  source: Record<string, string>,
  translated: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, text] of Object.entries(translated)) {
    const original = source[key];
    if (typeof text !== 'string' || original === undefined || !text.trim()) continue;
    if (messageArgs(text).join() === messageArgs(original).join()) out[key] = text;
  }
  return out;
}

/**
 * Adapts a plain-text model (DeepL, Google, LibreTranslate, NLLB, Marian, an on-prem LLM…):
 * placeholders are protected and plural/select branches are translated one by one.
 */
export function textTranslator(name: string, translate: TextTranslate, batchSize = 50): TranslationProvider {
  return {
    name,
    async translate(request) {
      const split = Object.entries(request.messages).map(([key, message]) => ({
        key,
        ...splitMessage(message),
      }));
      const unique = [...new Set(split.flatMap((s) => s.texts))];
      const translatedByText = new Map<string, string>();
      for (let i = 0; i < unique.length; i += batchSize) {
        const batch = unique.slice(i, i + batchSize);
        const result = await translate(batch, request);
        batch.forEach((text, j) => {
          if (typeof result[j] === 'string') translatedByText.set(text, result[j]!);
        });
      }
      const out: Record<string, string> = {};
      for (const s of split) {
        if (!s.texts.every((t) => translatedByText.has(t))) continue;
        const joined = s.join(s.texts.map((t) => translatedByText.get(t)!));
        if (joined !== null) out[s.key] = joined;
      }
      return out;
    },
  };
}

/** Claude, with structured output that returns exactly the requested keys. */
export function claudeTranslator(ai: { client: AiClient; model: string }): TranslationProvider {
  return {
    name: `claude (${ai.model})`,
    translate: (request) => translateMessages({ client: ai.client, model: ai.model, ...request }),
  };
}

export interface HttpTranslatorOptions {
  url: string;
  /** Sent as `Authorization: Bearer <token>`. */
  token?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

async function postJson(
  options: HttpTranslatorOptions,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const res = await (options.fetch ?? fetch)(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  if (!res.ok) throw new Error(`Translation service: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as unknown;
}

/**
 * Your own endpoint, in any language, with any model. Receives
 * `{ sourceLocale, locale, messages, context }` and returns `{ messages }`.
 */
export function webhookTranslator(options: HttpTranslatorOptions): TranslationProvider {
  return {
    name: 'webhook',
    async translate(request) {
      const body = (await postJson(
        options,
        options.url,
        request,
        options.token ? { authorization: `Bearer ${options.token}` } : {},
      )) as { messages?: Record<string, string> };
      return body.messages ?? {};
    },
  };
}

/** DeepL API (free keys end with `:fx`). */
export function deeplTranslator(
  options: Omit<HttpTranslatorOptions, 'url'> & { apiKey: string; url?: string },
) {
  const url =
    options.url ??
    (options.apiKey.endsWith(':fx')
      ? 'https://api-free.deepl.com/v2/translate'
      : 'https://api.deepl.com/v2/translate');
  const target = (locale: string) => {
    const [lang, region] = locale.split('-');
    const upper = lang!.toUpperCase();
    if (upper === 'EN') return region?.toUpperCase() === 'GB' ? 'EN-GB' : 'EN-US';
    if (upper === 'PT') return region?.toUpperCase() === 'BR' ? 'PT-BR' : 'PT-PT';
    if (upper === 'ZH') return /hant|tw|hk/i.test(locale) ? 'ZH-HANT' : 'ZH-HANS';
    return upper;
  };
  return textTranslator('deepl', async (texts, request) => {
    const body = (await postJson(
      { ...options, url },
      url,
      {
        text: texts,
        source_lang: request.sourceLocale.split('-')[0]!.toUpperCase(),
        target_lang: target(request.locale),
      },
      { authorization: `DeepL-Auth-Key ${options.apiKey}` },
    )) as { translations?: { text: string }[] };
    return (body.translations ?? []).map((t) => t.text);
  });
}

/** LibreTranslate (self-hosted open models, or a hosted instance). */
export function libreTranslator(options: HttpTranslatorOptions & { apiKey?: string }) {
  const url = `${options.url.replace(/\/+$/, '')}/translate`;
  return textTranslator('libretranslate', async (texts, request) => {
    const body = (await postJson(options, url, {
      q: texts,
      source: request.sourceLocale.split('-')[0],
      target: request.locale.split('-')[0],
      format: 'text',
      ...(options.apiKey ? { api_key: options.apiKey } : {}),
    })) as { translatedText?: string | string[] };
    const result = body.translatedText;
    return Array.isArray(result) ? result : result === undefined ? [] : [result];
  });
}

/** Translates in chunks and drops results with broken placeholders. */
export async function translateChecked(
  provider: TranslationProvider,
  request: TranslationRequest,
  chunk = 100,
): Promise<Record<string, string>> {
  const entries = Object.entries(request.messages);
  const out: Record<string, string> = {};
  for (let i = 0; i < entries.length; i += chunk) {
    const messages = Object.fromEntries(entries.slice(i, i + chunk));
    Object.assign(out, checkTranslations(messages, await provider.translate({ ...request, messages })));
  }
  return out;
}
