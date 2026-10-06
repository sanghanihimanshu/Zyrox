import type { Document, StringsBundle } from '@wishyor/zyrox-protocol';
import { PROTOCOL_VERSION } from '@wishyor/zyrox-protocol';
import type { Messages, MissingTranslator } from './i18n';
import { FetchError, type FunctionCallContext, type Observer, type ZyroxEvent } from './runtime';

/** Key-value storage: `localStorage`, AsyncStorage, an MMKV wrapper… Sync or async. */
export interface ClientStorage {
  getItem(key: string): string | null | undefined | Promise<string | null | undefined>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

export interface Experiment {
  key: string;
  variant: string;
  /** Documents this experiment affects; exposure is reported when one is viewed. */
  docs: string[];
}

export interface Bootstrap {
  /** Seconds before the client should refresh. */
  ttl: number;
  /** Document key → immutable content ref. */
  docs: Record<string, string>;
  strings?: {
    defaultLocale: string;
    refs: Record<string, string>;
    /** The server machine-translates missing strings (`/v1/translate`). */
    translate?: boolean;
  };
  experiments: Experiment[];
}

/** Everything needed to render without network: ship it in the app for the first launch. */
export interface Snapshot {
  bootstrap: Bootstrap;
  docs: Record<string, Document>;
  strings?: Record<string, StringsBundle>;
}

export interface ZyroxClientOptions {
  endpoint: string;
  publicKey: string;
  manifestHash: string;
  platform: string;
  appVersion?: string;
  /** Stable user or install id for rollout/experiment bucketing. Generated and stored when omitted. */
  user?: string;
  /** Targeting attributes (country, plan…). */
  attrs?: Record<string, string | number | boolean>;
  /**
   * Your app's token for the signed-in user (e.g. a JWT). Sent with remote function calls and
   * forwarded to your function as `x-zyrox-user-token`, so it can authenticate the caller.
   */
  userToken?: () => string | null | undefined | Promise<string | null | undefined>;
  locales?: () => readonly string[];
  storage?: ClientStorage;
  snapshot?: Snapshot;
  fetch?: typeof fetch;
  /** Telemetry flush interval in ms. Default 30 000. `0` disables the timer. */
  telemetryInterval?: number;
  /** Per-request timeout in ms (bootstrap, documents, strings). Default 15 000. */
  timeoutMs?: number;
  /** Retries for failed loads (network errors, 5xx, 429), with exponential backoff. Default 2. */
  retries?: number;
  /** First retry delay in ms; doubles each time, plus jitter. Default 400. */
  retryDelayMs?: number;
  /**
   * Which documents to download after each bootstrap: `'all'` (default, best for offline),
   * `'none'` (on demand), or a list of keys (e.g. the screens of your tab bar).
   */
  prefetch?: 'all' | 'none' | readonly string[];
  /**
   * A draft preview token (`zpv_…`, from the dashboard or `zyrox preview-token`): the app shows
   * drafts instead of releases. Nothing is cached to storage and no telemetry is sent.
   */
  previewToken?: string;
}

export type DocumentStatus =
  | {
      status: 'ready';
      document: Document;
      ref: string;
      source: 'cache' | 'network' | 'snapshot';
      /** The previous version, shown while the new one downloads or when it failed to. */
      stale?: boolean;
    }
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; message: string };

const KEY_BOOTSTRAP = 'zyrox:bootstrap';
const KEY_USER = 'zyrox:user';
const KEY_INDEX = 'zyrox:index';
const docKey = (ref: string) => `zyrox:doc:${ref}`;
const stringsKey = (ref: string) => `zyrox:strings:${ref}`;
const mtKey = (sourceRef: string, locale: string) => `zyrox:mt:${sourceRef}:${locale}`;
/** How long a failed document waits before `getDocument` retries it. */
const FAILURE_COOLDOWN_MS = 10_000;
const PREFETCH_CONCURRENCY = 4;
const MAX_TELEMETRY_KEYS = 500;

interface StoredBootstrap {
  bootstrap: Bootstrap;
  fetchedAt: number;
  etag?: string;
  /** Document key → previous ref, kept until the new version is downloaded. */
  fallback?: Record<string, string>;
}

const isPromise = <T>(value: unknown): value is Promise<T> =>
  typeof (value as { then?: unknown } | null)?.then === 'function';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function encodeHeader(values: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(values)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('; ');
}

function randomId(): string {
  let id = '';
  for (let i = 0; i < 4; i++) id += Math.floor(Math.random() * 0x100000000).toString(36);
  return `anon_${id}`;
}

/**
 * Talks to the Zyrox server: per-user bootstrap (revalidated with ETags), immutable documents and
 * translation bundles (cached forever by content hash, pruned when no longer released), remote
 * function calls, runtime translation and batched telemetry. Built for flaky mobile networks:
 * timeouts, retries with backoff, the previous version as fallback, and synchronous hydration
 * from synchronous storage (MMKV, localStorage) so cached screens render on the first frame.
 */
export class ZyroxClient {
  private readonly options: ZyroxClientOptions;
  private readonly docs = new Map<string, { document: Document; source: 'cache' | 'network' | 'snapshot' }>();
  private readonly loadingDocs = new Map<string, Promise<Document | undefined>>();
  private readonly failed = new Map<string, { message: string; at: number }>();
  private readonly listeners = new Set<() => void>();
  private readonly telemetry = new Map<string, { event: Record<string, unknown>; count: number }>();
  /** Storage keys this client wrote (documents, strings, machine translations), for pruning. */
  private readonly stored = new Set<string>();
  private readonly pendingTranslations = new Map<string, Map<string, ((text: string | null) => void)[]>>();
  private readonly machineTranslations = new Map<string, Promise<Record<string, string>>>();
  private bootstrap: Bootstrap | undefined;
  private fetchedAt = 0;
  private etag: string | undefined;
  private fallback: Record<string, string> = {};
  private user: string | undefined;
  private readyPromise: Promise<void> | undefined;
  private refreshing: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private version = 0;

  constructor(options: ZyroxClientOptions) {
    // Previews never touch the offline cache, so drafts can't outlive the session.
    this.options = options.previewToken ? { ...options, storage: undefined } : options;
    this.user = options.user;
    this.hydrateSync();
    if (options.snapshot) this.applySnapshot(options.snapshot);
    const interval = options.telemetryInterval ?? 30_000;
    if (interval > 0) this.timer = setInterval(() => void this.flush(), interval);
  }

  private get fetchFn(): typeof fetch {
    return this.options.fetch ?? fetch;
  }

  private url(path: string): string {
    return `${this.options.endpoint.replace(/\/+$/, '')}${path}`;
  }

  private headers(): Record<string, string> {
    const o = this.options;
    const headers: Record<string, string> = {
      authorization: `Bearer ${o.publicKey}`,
      'x-zyrox-client': encodeHeader({
        platform: o.platform,
        app: o.appVersion,
        manifest: o.manifestHash,
        protocol: PROTOCOL_VERSION,
      }),
    };
    if (this.user) headers['x-zyrox-user'] = this.user;
    if (o.attrs && Object.keys(o.attrs).length) headers['x-zyrox-attrs'] = encodeHeader(o.attrs);
    const locales = o.locales?.() ?? [];
    if (locales.length) headers['accept-language'] = locales.join(', ');
    if (o.previewToken) headers['x-zyrox-preview'] = o.previewToken;
    return headers;
  }

  /**
   * GET/POST with a timeout (covering the body) and retries with exponential backoff and jitter
   * on network errors, 5xx and 429. Returns the status and body text.
   */
  private async request(
    path: string,
    init: RequestInit = {},
    retries = this.options.retries ?? 2,
  ): Promise<{ status: number; ok: boolean; text: string; headers: Headers }> {
    for (let attempt = 0; ; attempt++) {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
      const timer = controller
        ? setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000)
        : undefined;
      try {
        const res = await this.fetchFn(this.url(path), { ...init, signal: controller?.signal });
        const text = res.status === 304 ? '' : await res.text();
        if ((res.status >= 500 || res.status === 429) && attempt < retries) {
          await this.backoff(attempt);
          continue;
        }
        return { status: res.status, ok: res.ok, text, headers: res.headers };
      } catch (err) {
        if (attempt >= retries) {
          const timedOut = controller?.signal.aborted;
          throw new FetchError(
            timedOut ? `Request timed out: ${path}` : err instanceof Error ? err.message : String(err),
            0,
          );
        }
        await this.backoff(attempt);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  private backoff(attempt: number): Promise<void> {
    const base = this.options.retryDelayMs ?? 400;
    return sleep(base * 2 ** attempt + Math.random() * base).then(() => undefined);
  }

  /** A number that changes whenever the bootstrap or a document changes (for `useSyncExternalStore`). */
  getVersion = (): number => this.version;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify(): void {
    this.version++;
    for (const l of [...this.listeners]) l();
  }

  private applySnapshot(snapshot: Snapshot): void {
    this.bootstrap ??= snapshot.bootstrap;
    for (const [ref, document] of Object.entries(snapshot.docs)) {
      if (!this.docs.has(ref)) this.docs.set(ref, { document, source: 'snapshot' });
    }
  }

  private restore(rawBootstrap: string | null | undefined, rawIndex: string | null | undefined): void {
    if (rawBootstrap) {
      const saved = JSON.parse(rawBootstrap) as StoredBootstrap;
      this.bootstrap = saved.bootstrap;
      this.fetchedAt = saved.fetchedAt;
      this.etag = saved.etag;
      this.fallback = saved.fallback ?? {};
    }
    if (rawIndex) for (const key of JSON.parse(rawIndex) as string[]) this.stored.add(key);
  }

  /** With synchronous storage (MMKV, localStorage), restore everything before the first render. */
  private hydrateSync(): void {
    const storage = this.options.storage;
    if (!storage) return;
    try {
      const rawBootstrap = storage.getItem(KEY_BOOTSTRAP);
      if (isPromise(rawBootstrap)) {
        rawBootstrap.catch(() => {});
        return;
      }
      const rawIndex = storage.getItem(KEY_INDEX) as string | null | undefined;
      const rawUser = storage.getItem(KEY_USER) as string | null | undefined;
      this.restore(rawBootstrap, rawIndex);
      if (!this.user) {
        this.user = rawUser || randomId();
        if (!rawUser) void storage.setItem(KEY_USER, this.user);
      }
      this.readyPromise = Promise.resolve();
    } catch {
      // Corrupt cache: start fresh.
    }
  }

  /** Synchronously reads a cached value when the storage is synchronous. */
  private readSync(key: string): string | undefined {
    try {
      const value = this.options.storage?.getItem(key);
      if (isPromise(value)) {
        value.catch(() => {});
        return undefined;
      }
      return value ?? undefined;
    } catch {
      return undefined;
    }
  }

  private async store(key: string, value: string): Promise<void> {
    const storage = this.options.storage;
    if (!storage) return;
    try {
      await storage.setItem(key, value);
      if (!this.stored.has(key)) {
        this.stored.add(key);
        await storage.setItem(KEY_INDEX, JSON.stringify([...this.stored]));
      }
    } catch {
      // Full or unavailable storage: keep working from memory.
    }
  }

  private async persistBootstrap(): Promise<void> {
    if (!this.bootstrap) return;
    const record: StoredBootstrap = {
      bootstrap: this.bootstrap,
      fetchedAt: this.fetchedAt,
      etag: this.etag,
      fallback: this.fallback,
    };
    try {
      await this.options.storage?.setItem(KEY_BOOTSTRAP, JSON.stringify(record));
    } catch {
      // ignore
    }
  }

  /** Restores the cached bootstrap and user id from storage. Safe to call many times. */
  ready(): Promise<void> {
    this.readyPromise ??= (async () => {
      const storage = this.options.storage;
      if (!storage) {
        this.user ??= randomId();
        return;
      }
      try {
        const [rawBootstrap, rawUser, rawIndex] = await Promise.all([
          storage.getItem(KEY_BOOTSTRAP),
          storage.getItem(KEY_USER),
          storage.getItem(KEY_INDEX),
        ]);
        this.restore(rawBootstrap, rawIndex);
        if (!this.user) {
          this.user = rawUser || randomId();
          if (!rawUser) await storage.setItem(KEY_USER, this.user);
        }
      } catch {
        this.user ??= randomId();
      }
      this.notify();
    })();
    return this.readyPromise;
  }

  getBootstrap(): Bootstrap | undefined {
    return this.bootstrap;
  }

  getUser(): string | undefined {
    return this.user;
  }

  /**
   * Revalidates the bootstrap (unless it is within its TTL) with an ETag, so unchanged
   * bootstraps cost a 304, then prefetches documents and prunes versions no longer released.
   */
  refresh(force = false): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      await this.ready();
      const fresh = this.bootstrap && Date.now() - this.fetchedAt < this.bootstrap.ttl * 1000;
      if (!force && fresh) return;
      const headers = this.headers();
      if (this.etag && this.bootstrap) headers['if-none-match'] = this.etag;
      const res = await this.request('/v1/bootstrap', { headers });
      if (res.status === 304 && this.bootstrap) {
        this.fetchedAt = Date.now();
      } else {
        if (!res.ok) throw new FetchError(`Bootstrap failed: HTTP ${res.status}`, res.status);
        const bootstrap = JSON.parse(res.text) as Bootstrap;
        const previous = this.bootstrap;
        // Keep the version on screen until its replacement has downloaded.
        for (const [key, ref] of Object.entries(previous?.docs ?? {})) {
          if (bootstrap.docs[key] !== ref && this.available(ref)) this.fallback[key] = ref;
        }
        for (const key of Object.keys(this.fallback)) if (!(key in bootstrap.docs)) delete this.fallback[key];
        this.bootstrap = bootstrap;
        this.fetchedAt = Date.now();
        this.etag = res.headers.get('etag') ?? undefined;
        this.failed.clear();
        this.notify();
      }
      await this.persistBootstrap();
      await this.prefetch();
      await this.prune();
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private available(ref: string): boolean {
    return this.docs.has(ref) || this.stored.has(docKey(ref));
  }

  private async prefetch(): Promise<void> {
    const bootstrap = this.bootstrap;
    const mode = this.options.prefetch ?? 'all';
    if (!bootstrap || mode === 'none') return;
    const keys = mode === 'all' ? Object.keys(bootstrap.docs) : mode.filter((k) => k in bootstrap.docs);
    const queue = keys.map((k) => bootstrap.docs[k]!).filter((ref) => !this.docs.has(ref));
    const worker = async () => {
      for (let ref = queue.shift(); ref; ref = queue.shift()) await this.loadDocument(ref);
    };
    await Promise.all(Array.from({ length: Math.min(PREFETCH_CONCURRENCY, queue.length) }, worker));
  }

  /** Removes cached documents, strings and translations that the current bootstrap no longer uses. */
  private async prune(): Promise<void> {
    const bootstrap = this.bootstrap;
    if (!bootstrap) return;
    for (const [key, ref] of Object.entries(this.fallback)) {
      const current = bootstrap.docs[key];
      if (current && this.docs.has(current)) delete this.fallback[key];
      else if (!this.available(ref)) delete this.fallback[key];
    }
    const refs = new Set([...Object.values(bootstrap.docs), ...Object.values(this.fallback)]);
    const strings = Object.values(bootstrap.strings?.refs ?? {});
    const source = bootstrap.strings?.refs[bootstrap.strings.defaultLocale];
    const keep = new Set([...[...refs].map(docKey), ...strings.map(stringsKey)]);
    for (const ref of [...this.docs.keys()]) if (!refs.has(ref)) this.docs.delete(ref);
    const stale = [...this.stored].filter(
      (key) => !keep.has(key) && !(source && key.startsWith(`zyrox:mt:${source}:`)),
    );
    if (!stale.length) return this.persistBootstrap();
    const storage = this.options.storage;
    for (const key of stale) {
      this.stored.delete(key);
      try {
        await storage?.removeItem(key);
      } catch {
        // ignore
      }
    }
    try {
      await storage?.setItem(KEY_INDEX, JSON.stringify([...this.stored]));
    } catch {
      // ignore
    }
    await this.persistBootstrap();
  }

  private entry(ref: string) {
    const cached = this.docs.get(ref);
    if (cached) return cached;
    // Synchronous storage: render the cached version on this frame.
    const raw = this.stored.has(docKey(ref)) ? this.readSync(docKey(ref)) : undefined;
    if (!raw) return undefined;
    try {
      const entry = { document: JSON.parse(raw) as Document, source: 'cache' as const };
      this.docs.set(ref, entry);
      return entry;
    } catch {
      return undefined;
    }
  }

  /** Current document for a key, loading it in the background when needed. */
  getDocument(key: string): DocumentStatus {
    const ref = this.bootstrap?.docs[key];
    if (!ref) return this.bootstrap ? { status: 'missing' } : { status: 'loading' };
    const entry = this.entry(ref);
    if (entry) return { status: 'ready', document: entry.document, ref, source: entry.source };
    const failure = this.failed.get(ref);
    if (failure && Date.now() - failure.at < FAILURE_COOLDOWN_MS) {
      const previous = this.previous(key);
      return previous ?? { status: 'error', message: failure.message };
    }
    void this.loadDocument(ref);
    return this.previous(key) ?? { status: 'loading' };
  }

  private previous(key: string): DocumentStatus | undefined {
    const ref = this.fallback[key];
    const entry = ref ? this.entry(ref) : undefined;
    return ref && entry
      ? { status: 'ready', document: entry.document, ref, source: entry.source, stale: true }
      : undefined;
  }

  /** Loads an immutable document by ref: memory, then storage, then network. */
  loadDocument(ref: string): Promise<Document | undefined> {
    const cached = this.docs.get(ref);
    if (cached) return Promise.resolve(cached.document);
    let pending = this.loadingDocs.get(ref);
    if (pending) return pending;
    pending = (async () => {
      try {
        const stored = await this.options.storage?.getItem(docKey(ref));
        if (stored) {
          const document = JSON.parse(stored) as Document;
          this.docs.set(ref, { document, source: 'cache' });
          this.stored.add(docKey(ref));
          this.notify();
          return document;
        }
        const res = await this.request(`/v1/docs/${encodeURIComponent(ref)}`, { headers: this.headers() });
        if (!res.ok) throw new FetchError(`Document ${ref}: HTTP ${res.status}`, res.status);
        const document = JSON.parse(res.text) as Document;
        this.docs.set(ref, { document, source: 'network' });
        this.failed.delete(ref);
        await this.store(docKey(ref), res.text);
        this.notify();
        return document;
      } catch (err) {
        this.failed.set(ref, { message: err instanceof Error ? err.message : String(err), at: Date.now() });
        this.notify();
        return undefined;
      } finally {
        this.loadingDocs.delete(ref);
      }
    })();
    this.loadingDocs.set(ref, pending);
    return pending;
  }

  /** Locales the server has translations for. */
  locales(): string[] {
    return Object.keys(this.bootstrap?.strings?.refs ?? {});
  }

  /** Loads one locale's messages (cached by content ref). Use as the i18n `loader`. */
  loadStrings = async (locale: string): Promise<Messages | null> => {
    await this.ready();
    const ref = this.bootstrap?.strings?.refs[locale];
    if (!ref) return null;
    const stored = await this.options.storage?.getItem(stringsKey(ref));
    if (stored) return (JSON.parse(stored) as StringsBundle).messages;
    const res = await this.request(`/v1/strings/${encodeURIComponent(ref)}`, { headers: this.headers() });
    if (!res.ok) throw new FetchError(`Strings ${locale}: HTTP ${res.status}`, res.status);
    await this.store(stringsKey(ref), res.text);
    return (JSON.parse(res.text) as StringsBundle).messages;
  };

  /**
   * Machine-translates missing strings through the server's translation provider (when it has
   * runtime translation enabled). Requests are batched; results are kept in storage until the
   * source strings change. Use as the i18n `translateMissing`.
   */
  translateMissing: MissingTranslator = (request) => {
    if (request.locale === request.sourceLocale || !request.source || !this.bootstrap?.strings?.translate)
      return Promise.resolve(null);
    return this.savedTranslations(request.locale).then((saved) => {
      if (request.key in saved) return saved[request.key]!;
      return new Promise<string | null>((resolve) => {
        let batch = this.pendingTranslations.get(request.locale);
        if (!batch) {
          batch = new Map();
          this.pendingTranslations.set(request.locale, batch);
          setTimeout(() => void this.sendTranslations(request.locale), 30);
        }
        const waiting = batch.get(request.key);
        if (waiting) waiting.push(resolve);
        else batch.set(request.key, [resolve]);
      });
    });
  };

  private sourceRef(): string | undefined {
    const strings = this.bootstrap?.strings;
    return strings?.refs[strings.defaultLocale];
  }

  private savedTranslations(locale: string): Promise<Record<string, string>> {
    const source = this.sourceRef();
    if (!source) return Promise.resolve({});
    const key = mtKey(source, locale);
    let saved = this.machineTranslations.get(key);
    if (!saved) {
      saved = (async () => {
        try {
          const raw = await this.options.storage?.getItem(key);
          return raw ? (JSON.parse(raw) as Record<string, string>) : {};
        } catch {
          return {};
        }
      })();
      this.machineTranslations.set(key, saved);
    }
    return saved;
  }

  private async sendTranslations(locale: string): Promise<void> {
    const batch = this.pendingTranslations.get(locale);
    this.pendingTranslations.delete(locale);
    if (!batch) return;
    const keys = [...batch.keys()];
    const result: Record<string, string> = {};
    for (let i = 0; i < keys.length; i += 100) {
      try {
        const res = await this.request(
          '/v1/translate',
          {
            method: 'POST',
            headers: { ...this.headers(), 'content-type': 'application/json' },
            body: JSON.stringify({ locale, keys: keys.slice(i, i + 100) }),
          },
          0,
        );
        if (res.ok)
          Object.assign(result, (JSON.parse(res.text) as { messages?: Record<string, string> }).messages);
      } catch {
        // Untranslated keys fall back to the source language.
      }
    }
    for (const [key, resolvers] of batch) for (const resolve of resolvers) resolve(result[key] ?? null);
    const source = this.sourceRef();
    if (source && Object.keys(result).length) {
      const saved = { ...(await this.savedTranslations(locale)), ...result };
      this.machineTranslations.set(mtKey(source, locale), Promise.resolve(saved));
      await this.store(mtKey(source, locale), JSON.stringify(saved));
    }
  }

  /** Runs a remote function through the Zyrox server. Use as the runtime's `callFunction`. */
  callFunction = async (
    fn: string,
    args: Record<string, unknown>,
    ctx: FunctionCallContext,
  ): Promise<unknown> => {
    await this.ready();
    const userToken = await this.options.userToken?.();
    const res = await this.fetchFn(this.url(`/v1/functions/${encodeURIComponent(fn)}`), {
      method: 'POST',
      headers: {
        ...this.headers(),
        'content-type': 'application/json',
        ...(userToken ? { 'x-zyrox-user-token': userToken } : {}),
      },
      body: JSON.stringify({ args, screen: ctx.screen, nodeId: ctx.nodeId }),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: { message?: string } };
    if (!res.ok)
      throw new FetchError(
        body.error?.message ?? `Function ${fn} failed: HTTP ${res.status}`,
        res.status,
        body,
      );
    return body.result;
  };

  /** Observer that aggregates views and errors into telemetry counters. */
  observer: Observer = (event: ZyroxEvent) => {
    if (event.type !== 'screen_view' && event.type !== 'error' && event.type !== 'exposure') return;
    // Your own screens' events (useZyroxActions) aren't Zyrox documents; previews aren't traffic.
    if (event.origin === 'app' || this.options.previewToken) return;
    const record: Record<string, unknown> = {
      type: event.type,
      screen: event.screen,
      version: event.version,
    };
    if (event.type === 'error') {
      record.kind = event.kind;
      record.nodeId = event.nodeId;
      record.message = event.message.slice(0, 200);
    }
    if (event.type === 'exposure') {
      record.experiment = event.experiment;
      record.variant = event.variant;
    }
    this.count(record, 1);
  };

  private count(record: Record<string, unknown>, n: number): void {
    const key = JSON.stringify(record);
    const entry = this.telemetry.get(key);
    if (entry) entry.count += n;
    else if (this.telemetry.size < MAX_TELEMETRY_KEYS) this.telemetry.set(key, { event: record, count: n });
  }

  /** Sends aggregated telemetry. Called on a timer and when the app goes to the background. */
  async flush(): Promise<void> {
    if (this.telemetry.size === 0) return;
    const entries = [...this.telemetry.values()];
    this.telemetry.clear();
    try {
      const res = await this.fetchFn(this.url('/v1/telemetry'), {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ events: entries.map(({ event, count }) => ({ ...event, count })) }),
        keepalive: true,
      });
      if (res.status >= 500) throw new Error('retry later');
    } catch {
      // Offline or server trouble: keep the counts for the next flush.
      for (const { event, count } of entries) this.count(event, count);
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    void this.flush();
  }
}
