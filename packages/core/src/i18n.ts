/**
 * Built-in translations. Messages support `{name}` placeholders, plurals and selects:
 *
 *   "Hello {name}"
 *   "{count, plural, =0 {No items} one {# item} other {# items}}"
 *   "{role, select, admin {Admin} other {Member}}"
 */

type Part =
  | string
  | { arg: string }
  | { arg: string; type: 'plural' | 'select'; options: Record<string, Part[]> }
  | { hash: true };

const parsed = new Map<string, Part[]>();

class MessageError extends Error {}

function parseMessage(message: string): Part[] {
  const cached = parsed.get(message);
  if (cached) return cached;
  let i = 0;
  const parse = (inPlural: boolean, untilBrace: boolean): Part[] => {
    const parts: Part[] = [];
    let text = '';
    const flush = () => {
      if (text) parts.push(text);
      text = '';
    };
    while (i < message.length) {
      const c = message[i]!;
      if (c === '}' && untilBrace) {
        flush();
        return parts;
      }
      if (c === '#' && inPlural) {
        flush();
        parts.push({ hash: true });
        i++;
        continue;
      }
      if (c !== '{') {
        text += c;
        i++;
        continue;
      }
      flush();
      i++;
      const head = /^\s*([A-Za-z0-9_.]+)\s*(?:,\s*(plural|select)\s*,)?\s*/.exec(message.slice(i));
      if (!head) throw new MessageError(`Bad placeholder at ${i}`);
      i += head[0].length;
      const arg = head[1]!;
      const type = head[2] as 'plural' | 'select' | undefined;
      if (!type) {
        if (message[i] !== '}') throw new MessageError(`Expected "}" at ${i}`);
        i++;
        parts.push({ arg });
        continue;
      }
      const options: Record<string, Part[]> = {};
      for (;;) {
        const m = /^\s*(=?[A-Za-z0-9_]+)\s*\{/.exec(message.slice(i));
        if (!m) break;
        i += m[0].length;
        options[m[1]!] = parse(type === 'plural', true);
        if (message[i] !== '}') throw new MessageError(`Unclosed option at ${i}`);
        i++;
      }
      const close = /^\s*\}/.exec(message.slice(i));
      if (!close) throw new MessageError(`Expected "}" at ${i}`);
      i += close[0].length;
      parts.push({ arg, type, options });
    }
    if (untilBrace) throw new MessageError('Unclosed "{"');
    flush();
    return parts;
  };
  let result: Part[];
  try {
    result = parse(false, false);
  } catch {
    result = [message];
  }
  if (parsed.size > 2000) parsed.clear();
  parsed.set(message, result);
  return result;
}

const pluralRules = new Map<string, Intl.PluralRules>();
function pluralCategory(locale: string, n: number): string {
  let rules = pluralRules.get(locale);
  if (!rules) {
    try {
      rules = new Intl.PluralRules(locale);
    } catch {
      rules = new Intl.PluralRules('en');
    }
    pluralRules.set(locale, rules);
  }
  return rules.select(n);
}

function read(vars: Record<string, unknown>, path: string): unknown {
  let cur: unknown = vars;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function render(parts: Part[], vars: Record<string, unknown>, locale: string, count?: number): string {
  let out = '';
  for (const part of parts) {
    if (typeof part === 'string') out += part;
    else if ('hash' in part) out += count === undefined ? '#' : new Intl.NumberFormat(locale).format(count);
    else if (!('type' in part)) {
      const v = read(vars, part.arg);
      out += v === undefined || v === null ? `{${part.arg}}` : String(v);
    } else {
      const v = read(vars, part.arg);
      if (part.type === 'plural') {
        const n = Number(v);
        const branch =
          part.options[`=${n}`] ?? part.options[pluralCategory(locale, n)] ?? part.options.other ?? [];
        out += render(branch, vars, locale, n);
      } else {
        out += render(part.options[String(v)] ?? part.options.other ?? [], vars, locale, count);
      }
    }
  }
  return out;
}

export function formatMessage(message: string, vars: Record<string, unknown> = {}, locale = 'en'): string {
  return render(parseMessage(message), vars, locale);
}

/** Placeholder and plural/select argument names used by a message, sorted (to check translations). */
export function messageArgs(message: string): string[] {
  const args: string[] = [];
  const walk = (parts: Part[]) => {
    for (const part of parts) {
      if (typeof part === 'string' || 'hash' in part) continue;
      args.push('type' in part ? `${part.arg}:${part.type}` : part.arg);
      if ('type' in part) for (const branch of Object.values(part.options)) walk(branch);
    }
  };
  walk(parseMessage(message));
  return [...new Set(args)].sort();
}

/**
 * Prepares a message for a plain-text machine translation model: returns the human text runs
 * (placeholders become `{0}`, `{1}`… tokens, plural/select branches are separate runs) and
 * `join`, which rebuilds the message from translated runs, or returns `null` when the model
 * dropped or changed a token.
 */
export function splitMessage(message: string): {
  texts: string[];
  join(translated: string[]): string | null;
} {
  const parts = parseMessage(message);
  const texts: string[] = [];
  const runs: { tokens: string[]; lead: string; trail: string }[] = [];
  // Each run is a sequence of text, simple placeholders and `#`, between plural/select blocks.
  const plan = (list: Part[]): (Part | { run: number })[] => {
    const out: (Part | { run: number })[] = [];
    let text = '';
    let tokens: string[] = [];
    const flush = () => {
      if (text.trim()) {
        out.push({ run: runs.length });
        runs.push({ tokens, lead: /^\s*/.exec(text)![0], trail: /\s*$/.exec(text)![0] });
        texts.push(text.trim());
      } else if (text) out.push(text);
      text = '';
      tokens = [];
    };
    for (const part of list) {
      if (typeof part === 'string') text += part;
      else if ('hash' in part || !('type' in part)) {
        text += `{${tokens.length}}`;
        tokens.push('hash' in part ? '#' : `{${part.arg}}`);
      } else {
        flush();
        out.push({
          ...part,
          options: Object.fromEntries(
            Object.entries(part.options).map(([k, v]) => [k, plan(v) as unknown as Part[]]),
          ),
        });
      }
    }
    flush();
    return out;
  };
  const planned = plan(parts);
  return {
    texts,
    join(translated) {
      if (translated.length !== texts.length) return null;
      const rebuilt: string[] = [];
      for (const [i, run] of runs.entries()) {
        const text = translated[i] ?? '';
        const found = text.match(/\{\d+\}/g) ?? [];
        if (found.length !== run.tokens.length || new Set(found).size !== run.tokens.length) return null;
        // Stray braces would change the message's structure.
        if (/[{}]/.test(text.replace(/\{\d+\}/g, ''))) return null;
        let ok = true;
        const out = text.replace(/\{(\d+)\}/g, (_, n: string) => {
          const token = run.tokens[Number(n)];
          if (token === undefined) ok = false;
          return token ?? '';
        });
        if (!ok) return null;
        rebuilt.push(run.lead + out.trim() + run.trail);
      }
      const emit = (list: (Part | { run: number })[]): string => {
        let out = '';
        for (const item of list) {
          if (typeof item === 'object' && 'run' in item) out += rebuilt[item.run];
          else if (typeof item === 'string') out += item;
          else if ('type' in item) {
            const options = Object.entries(item.options)
              .map(([name, branch]) => `${name} {${emit(branch as unknown as (Part | { run: number })[])}}`)
              .join(' ');
            out += `{${item.arg}, ${item.type}, ${options}}`;
          }
        }
        return out;
      };
      return emit(planned);
    },
  };
}

export interface Translator {
  (key: string, vars?: Record<string, unknown>): string;
  readonly locale: string;
  has(key: string): boolean;
}

/**
 * Creates `t(key, vars)`. Looks up `messages`, then each `fallbacks` bundle in order. Missing keys
 * return the key itself and are reported once through `onMissing`.
 */
export function createTranslator(
  locale: string,
  messages: Record<string, string>,
  fallbacks: Record<string, string>[] = [],
  onMissing?: (key: string, locale: string) => void,
  /** Called once per key that only exists in a fallback bundle (i.e. isn't translated yet). */
  onFallback?: (key: string, locale: string) => void,
): Translator {
  const reported = new Set<string>();
  const once = (key: string, fn?: (key: string, locale: string) => void) => {
    if (fn && !reported.has(key)) {
      reported.add(key);
      fn(key, locale);
    }
  };
  const lookup = (key: string): string | undefined => {
    if (Object.hasOwn(messages, key)) return messages[key];
    for (const bundle of fallbacks) {
      if (Object.hasOwn(bundle, key)) {
        once(key, onFallback);
        return bundle[key];
      }
    }
    return undefined;
  };
  const t = ((key: string, vars?: Record<string, unknown>) => {
    const message = lookup(String(key));
    if (message === undefined) {
      once(key, onMissing);
      return String(key);
    }
    return formatMessage(message, vars ?? {}, locale);
  }) as Translator;
  Object.defineProperty(t, 'locale', { value: locale });
  Object.defineProperty(t, 'has', { value: (key: string) => lookup(key) !== undefined });
  return t;
}

/**
 * Picks the best available locale for the user's preferred locales:
 * exact match, then same language (`fr-CA` → `fr`, `fr` → `fr-FR`), then the default.
 */
export function pickLocale(
  preferred: readonly string[],
  available: readonly string[],
  defaultLocale: string,
): string {
  const lower = new Map(available.map((a) => [a.toLowerCase(), a]));
  for (const want of preferred) {
    const exact = lower.get(want.toLowerCase());
    if (exact) return exact;
    const lang = want.toLowerCase().split('-')[0]!;
    const sameLang = lower.get(lang) ?? available.find((a) => a.toLowerCase().split('-')[0] === lang);
    if (sameLang) return sameLang;
  }
  return defaultLocale;
}

/** Locale fallback chain, e.g. `fr-CA` → [`fr-CA`, `fr`]. */
export function localeChain(locale: string): string[] {
  const parts = locale.split('-');
  const chain: string[] = [];
  for (let i = parts.length; i > 0; i--) chain.push(parts.slice(0, i).join('-'));
  return chain;
}

const RTL = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ku', 'ckb']);

export function isRtl(locale: string): boolean {
  return RTL.has(locale.toLowerCase().split('-')[0]!);
}

// --- Runtime i18n manager ----------------------------------------------------------------------

export type Messages = Record<string, string>;

/** Where messages came from. Later layers win: `runtime` > `remote` > `local`. */
export type MessageLayer = 'local' | 'remote' | 'runtime';
const LAYER_ORDER: readonly MessageLayer[] = ['local', 'remote', 'runtime'];

/** Fetches one locale's messages (from the Zyrox server, your CDN, a TMS…). */
export type BundleLoader = (locale: string) => Promise<Messages | null | undefined>;

/**
 * Translates a missing key at runtime (machine translation, a cloud function…). Receives the
 * default-locale text when there is one. The result is cached as a `runtime` message.
 */
export type MissingTranslator = (request: {
  key: string;
  locale: string;
  source?: string;
  sourceLocale: string;
}) => Promise<string | null | undefined>;

export interface I18nOptions {
  /** Active locale. Default: the best match of `preferred` among known locales, else `defaultLocale`. */
  locale?: string;
  defaultLocale?: string;
  /** The user's preferred locales (device settings), best first. */
  preferred?: readonly string[];
  /** Bundles shipped with the app, by locale. */
  local?: Record<string, Messages>;
  /** Locales that exist remotely even if not loaded yet. */
  available?: readonly string[];
  loader?: BundleLoader;
  translateMissing?: MissingTranslator;
  onMissing?(key: string, locale: string): void;
}

export interface I18nSnapshot {
  locale: string;
  defaultLocale: string;
  /** Every known locale (local, loaded or available remotely). */
  locales: string[];
  direction: 'ltr' | 'rtl';
  /** Bumped whenever messages or the locale change. */
  revision: number;
}

/**
 * Holds translations from three layers (local, remote, runtime), the active locale and runtime
 * switching. Shared by every screen; `t()` re-renders when it changes.
 */
export class I18n {
  private readonly layers = new Map<string, Partial<Record<MessageLayer, Messages>>>();
  private readonly listeners = new Set<() => void>();
  private readonly loads = new Map<string, Promise<void>>();
  private readonly translating = new Set<string>();
  private readonly available = new Set<string>();
  private readonly options: I18nOptions;
  private state: I18nSnapshot;
  private cachedTranslator?: { revision: number; t: Translator };
  /** True once a locale was chosen explicitly; until then new locales may re-pick the best match. */
  private explicit: boolean;

  constructor(options: I18nOptions = {}) {
    this.options = options;
    this.explicit = Boolean(options.locale);
    const defaultLocale = options.defaultLocale ?? 'en';
    for (const [locale, messages] of Object.entries(options.local ?? {}))
      this.layer(locale).local = { ...messages };
    for (const locale of options.available ?? []) this.available.add(locale);
    const known = this.knownLocales(defaultLocale);
    const locale = options.locale ?? pickLocale(options.preferred ?? [], known, defaultLocale);
    this.state = {
      locale,
      defaultLocale,
      locales: known,
      direction: isRtl(locale) ? 'rtl' : 'ltr',
      revision: 0,
    };
  }

  get locale(): string {
    return this.state.locale;
  }

  getSnapshot = (): I18nSnapshot => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private layer(locale: string): Partial<Record<MessageLayer, Messages>> {
    let entry = this.layers.get(locale);
    if (!entry) {
      entry = {};
      this.layers.set(locale, entry);
    }
    return entry;
  }

  private knownLocales(defaultLocale = this.state.defaultLocale): string[] {
    return [...new Set([defaultLocale, ...this.layers.keys(), ...this.available])].sort();
  }

  private bump(patch: Partial<I18nSnapshot> = {}): void {
    const locale = patch.locale ?? this.state.locale;
    this.state = {
      ...this.state,
      ...patch,
      locale,
      locales: this.knownLocales(),
      direction: isRtl(locale) ? 'rtl' : 'ltr',
      revision: this.state.revision + 1,
    };
    for (const listener of [...this.listeners]) listener();
  }

  /** Adds or replaces messages for a locale. `runtime` overrides `remote`, which overrides `local`. */
  addMessages(locale: string, messages: Messages, layer: MessageLayer = 'runtime'): void {
    const entry = this.layer(locale);
    entry[layer] = { ...entry[layer], ...messages };
    this.bump();
  }

  /** Locales the server has, so `setLocale` knows it can fetch them. */
  setAvailable(locales: readonly string[]): void {
    let changed = false;
    for (const l of locales) {
      if (!this.available.has(l)) {
        this.available.add(l);
        changed = true;
      }
    }
    if (!changed) return;
    const best = this.explicit
      ? this.state.locale
      : pickLocale(this.options.preferred ?? [], this.knownLocales(), this.state.defaultLocale);
    this.bump({ locale: best });
  }

  /** Loads remote bundles for the active locale and its fallbacks. */
  ensureLoaded(): Promise<void> {
    const chain = [...new Set([...localeChain(this.state.locale), ...localeChain(this.state.defaultLocale)])];
    return Promise.all(chain.map((l) => this.load(l))).then(() => undefined);
  }

  /** Fetches a locale's remote bundle (once; call again with `force` to refresh). */
  load(locale: string, force = false): Promise<void> {
    const loader = this.options.loader;
    if (!loader) return Promise.resolve();
    const existing = this.loads.get(locale);
    if (existing && !force) return existing;
    const promise = loader(locale)
      .then((messages) => {
        if (messages) {
          this.layer(locale).remote = { ...messages };
          this.bump();
        }
      })
      .catch(() => {
        this.loads.delete(locale);
      });
    this.loads.set(locale, promise);
    return promise;
  }

  /** Switches language at runtime. Loads the locale (and its fallbacks) first when a loader is set. */
  async setLocale(locale: string): Promise<void> {
    this.explicit = true;
    const chain = [...localeChain(locale), ...localeChain(this.state.defaultLocale)];
    await Promise.all([...new Set(chain)].map((l) => this.load(l)));
    if (locale !== this.state.locale) this.bump({ locale });
  }

  /** Merged messages for one exact locale. */
  messages(locale: string): Messages {
    const entry = this.layers.get(locale);
    if (!entry) return {};
    return Object.assign({}, ...LAYER_ORDER.map((layer) => entry[layer] ?? {}));
  }

  /** `t` for the active locale, with fallback through the locale chain and the default locale. */
  translator(): Translator {
    if (this.cachedTranslator?.revision === this.state.revision) return this.cachedTranslator.t;
    const { locale, defaultLocale } = this.state;
    const own = localeChain(locale);
    const fallbackChain = localeChain(defaultLocale).filter((l) => !own.includes(l));
    // The locale's own chain (fr-CA, fr) is "translated"; the default locale is only a fallback.
    const primary = Object.assign({}, ...[...own].reverse().map((l) => this.messages(l))) as Messages;
    const t = createTranslator(
      locale,
      primary,
      fallbackChain.map((l) => this.messages(l)),
      (key) => this.missing(key, locale),
      (key) => this.missing(key, locale),
    );
    this.cachedTranslator = { revision: this.state.revision, t };
    return t;
  }

  private missing(key: string, locale: string): void {
    this.options.onMissing?.(key, locale);
    if (locale === this.state.defaultLocale) return;
    const translate = this.options.translateMissing;
    const id = `${locale}\u0000${key}`;
    if (!translate || this.translating.has(id)) return;
    this.translating.add(id);
    const sourceLocale = this.state.defaultLocale;
    const source = locale === sourceLocale ? undefined : this.messages(sourceLocale)[key];
    translate({ key, locale, source, sourceLocale })
      .then((text) => {
        if (typeof text === 'string') this.addMessages(locale, { [key]: text }, 'runtime');
      })
      .catch(() => undefined);
  }
}
