import { type TranslationProvider, translateChecked } from './translation';

const MAX_ENTRIES = 20_000;
const CALLS_PER_MINUTE = 30;

/**
 * Translates missing strings for apps at runtime. Only keys of the project's own released
 * source bundle can be translated (never arbitrary text from clients); results are cached per
 * source bundle and locale, and model calls are rate limited per environment.
 */
export class RuntimeTranslator {
  private readonly cache = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<Record<string, string>>>();
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly provider: TranslationProvider) {}

  private allow(environmentId: string): boolean {
    const now = Date.now();
    const window = this.windows.get(environmentId);
    if (!window || now - window.start > 60_000) {
      this.windows.set(environmentId, { start: now, count: 1 });
      return true;
    }
    return ++window.count <= CALLS_PER_MINUTE;
  }

  async translate(request: {
    environmentId: string;
    project: string;
    sourceRef: string;
    sourceLocale: string;
    source: Record<string, string>;
    locale: string;
    keys: string[];
  }): Promise<Record<string, string>> {
    const id = (key: string) => `${request.sourceRef}\u0000${request.locale}\u0000${key}`;
    const out: Record<string, string> = {};
    const missing: Record<string, string> = {};
    for (const key of request.keys) {
      const source = request.source[key];
      if (typeof source !== 'string') continue;
      const hit = this.cache.get(id(key));
      if (hit !== undefined) out[key] = hit;
      else missing[key] = source;
    }
    const keys = Object.keys(missing).sort();
    if (!keys.length || !this.allow(request.environmentId)) return out;
    const batchId = id(keys.join('\u0001'));
    let pending = this.inflight.get(batchId);
    if (!pending) {
      pending = translateChecked(this.provider, {
        sourceLocale: request.sourceLocale,
        locale: request.locale,
        messages: missing,
        context: request.project,
      }).finally(() => this.inflight.delete(batchId));
      this.inflight.set(batchId, pending);
    }
    const translated = await pending;
    for (const [key, text] of Object.entries(translated)) {
      if (typeof text !== 'string' || !(key in missing)) continue;
      out[key] = text;
      this.cache.set(id(key), text);
      if (this.cache.size > MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    }
    return out;
  }
}
