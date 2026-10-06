import type { Action, Document, HttpMethod, Value } from '@wishyor/zyrox-protocol';
import {
  type CompiledAction,
  type CompiledDataSource,
  type CompiledDocument,
  type CompiledForm,
  type CompiledValue,
  compileActions,
  compileDocument,
  evalValue,
} from './compile';
import { type EvalEnv, MISSING } from './expr';
import { checkField } from './forms';
import { createBuiltinHelpers, type HelperTree, helperFunctions } from './helpers';
import type { I18n } from './i18n';
import type { OverlayButton, OverlayHost, SheetResult } from './overlays';
import { pathsOverlap } from './path';
import { Store } from './store';

// --- Events (for analytics, logging, error tracking, performance) ------------------------------

interface EventBase {
  /** Document key. */
  screen: string;
  /** Published version ref (content hash) when known. */
  version?: string;
  nodeId?: string;
  /** The node's `meta`, for your own tagging. */
  meta?: Record<string, Value>;
  time: number;
  /** `app` for events your own code reports with `useZyroxActions()` (non-Zyrox screens). */
  origin?: 'app';
}

export type ZyroxEvent = EventBase &
  (
    | { type: 'screen_view'; params: Record<string, unknown> }
    | {
        type: 'screen_load';
        durationMs: number;
        source: 'inline' | 'cache' | 'network' | 'snapshot' | 'bundled' | 'preview';
      }
    | { type: 'data_load'; key: string; durationMs: number; ok: boolean; status?: number; cached?: boolean }
    | { type: 'action'; action: string; durationMs: number; ok: boolean }
    | { type: 'track'; name: string; props: Record<string, unknown> }
    | { type: 'exposure'; experiment: string; variant: string }
    | {
        type: 'error';
        kind: 'expression' | 'action' | 'data' | 'render' | 'unknown_component' | 'document';
        message: string;
        source?: string;
      }
    | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; data?: unknown }
  );

/** Receives every runtime event. Use one per tool: analytics, error tracking, logging, tracing. */
export type Observer = (event: ZyroxEvent) => void;

type EventInput = ZyroxEvent extends infer E
  ? E extends ZyroxEvent
    ? Omit<E, keyof EventBase> & Partial<EventBase>
    : never
  : never;

// --- Host integration --------------------------------------------------------------------------

export interface FetchRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: unknown;
  /** The data source `kind` (e.g. `graphql`), if any. */
  kind?: string;
  /** `data` for document data sources, `request` for the request action. */
  source: 'data' | 'request';
  /** Data source key. */
  key?: string;
  signal?: AbortSignal;
}

export class FetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

/** Performs a request with your app's auth and returns the parsed response. Throw on failure. */
export type Fetcher = (request: FetchRequest) => Promise<unknown>;

export type Presentation = 'push' | 'replace' | 'modal' | 'sheet' | 'reset';

export interface NavigateOptions {
  presentation: Presentation;
  transition?: string;
}

export interface HostActionContext {
  screen: string;
  nodeId?: string;
  event: unknown;
  getState(path?: string): unknown;
  setState(path: string, value: unknown): void;
  navigate(to: string, params?: Record<string, unknown>, options?: Partial<NavigateOptions>): void;
  track(name: string, props?: Record<string, unknown>): void;
  refresh(dataKey?: string): Promise<void>;
}

export type HostAction = (args: Record<string, any>, ctx: HostActionContext) => unknown;

export interface DeviceInfo {
  platform: string;
  width: number;
  height: number;
  colorScheme: 'light' | 'dark';
  locale: string;
  direction: 'ltr' | 'rtl';
  [key: string]: unknown;
}

export interface FunctionCallContext {
  screen: string;
  nodeId?: string;
}

/** Calls a remote/cloud function by name and returns its result. Throw on failure. */
export type FunctionCaller = (
  fn: string,
  args: Record<string, unknown>,
  ctx: FunctionCallContext,
) => Promise<unknown>;

/**
 * Responses of data sources that set `cache`, shared by every screen under one provider, so
 * going back to or reopening a screen shows its data instantly. Memory only, least recently
 * used evicted. Call `clear()` on sign-out.
 */
export class DataCache {
  private readonly entries = new Map<string, { value: unknown; at: number }>();

  constructor(private readonly max = 200) {}

  get(key: string): { value: unknown; at: number } | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  set(key: string, value: unknown): void {
    this.entries.delete(key);
    this.entries.set(key, { value, at: Date.now() });
    if (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface RuntimeHost {
  /** Shared cache for data sources with `cache` (see `DataCache`). */
  dataCache?: DataCache;
  fetcher?: Fetcher;
  /** Base URL for relative `request`/data URLs. */
  apiBaseUrl?: string;
  /** Extra origins absolute request URLs may use (the `apiBaseUrl` origin is always allowed). */
  allowedOrigins?: string[];
  /** Schemes `openUrl` may open. Default `https:`, `http:`, `mailto:`, `tel:`. */
  urlSchemes?: string[];
  navigate?(to: string, params: Record<string, unknown>, options: NavigateOptions): void;
  back?(result?: unknown): void;
  openUrl?(url: string): unknown;
  actions?: Record<string, HostAction>;
  /** Runs the `call` action. `@wishyor/zyrox-react` wires this to the Zyrox server when an endpoint is set. */
  callFunction?: FunctionCaller;
  /** Translations and the active locale, shared by all screens. Powers `t()` and `setLocale`. */
  i18n?: I18n;
  helpers?: HelperTree;
  observers?: Observer[];
  /** Subscribe to the app returning to the foreground. */
  onForeground?(listener: () => void): () => void;
  /** Renders `sheet`, `alert` and `toast`. */
  overlays?: OverlayHost;
  /**
   * Actions your backend may trigger (`$actions` in responses, streams, push). Default:
   * `DEFAULT_REMOTE_ACTIONS`. Add your own app actions by name to allow them.
   */
  remoteActions?: readonly string[];
  /** Use each data source's `mock` instead of fetching (dashboard preview, tests). */
  mock?: boolean;
  /** Log every event to the console. */
  debug?: boolean;
}

/** Built-ins a backend may trigger by default: UI and navigation, nothing that sends data. */
export const DEFAULT_REMOTE_ACTIONS: readonly string[] = [
  'navigate',
  'back',
  'openUrl',
  'sheet',
  'closeSheet',
  'alert',
  'toast',
  'refresh',
  'track',
  'setState',
  'setLocale',
  'setErrors',
  'resetForm',
  'if',
];

// --- Scope -------------------------------------------------------------------------------------

/** Local variables (repeat items, `with`, action `event`) layered over the screen roots. */
export interface Frame {
  readonly vars: Record<string, unknown>;
  readonly parent: Frame | null;
}

export function childFrame(parent: Frame | null, vars: Record<string, unknown>): Frame {
  return { vars, parent };
}

/** Roots backed by the store; reads from them are tracked for re-rendering. */
export const STORE_ROOTS = [
  'state',
  'data',
  'loading',
  'error',
  'params',
  'app',
  'device',
  'i18n',
  'forms',
] as const;

/** What documents read as `forms.<name>`. */
export interface FormSnapshot {
  /** Current error per field (`null` when valid), whether shown or not. */
  errors: Record<string, string | null>;
  /** Errors to display: after the field was edited, or after `validate`. */
  shown: Record<string, string | null>;
  touched: Record<string, boolean>;
  /** Fields required without conditions (for asterisks). */
  required: Record<string, boolean>;
  submitted: boolean;
  valid: boolean;
}

interface FormEntry {
  form: CompiledForm;
  touched: Set<string>;
  submitted: boolean;
  /** Errors from your API (`setErrors`), shown until the field changes. */
  server: Record<string, string>;
  deps: Set<string>;
  initial: unknown;
}
const STORE_ROOT_SET: ReadonlySet<string> = new Set(STORE_ROOTS);

const SAFE_URL = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]*)/i;

function originOf(url: string): string | null {
  const m = SAFE_URL.exec(url);
  return m ? `${m[1]!.toLowerCase()}//${m[2]!.toLowerCase()}` : null;
}

function schemeOf(url: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*:)/i.exec(url);
  return m ? m[1]!.toLowerCase() : null;
}

export const defaultFetcher: Fetcher = async (req) => {
  const hasBody = req.body !== undefined && req.body !== null && req.method !== 'GET';
  const res = await fetch(req.url, {
    method: req.method,
    headers: {
      accept: 'application/json',
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...req.headers,
    },
    body: hasBody ? JSON.stringify(req.body) : undefined,
    signal: req.signal,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep text
  }
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'message' in body
        ? String((body as any).message)
        : `HTTP ${res.status}`;
    throw new FetchError(message, res.status, body);
  }
  return body;
};

export interface ScreenRuntimeOptions {
  document: Document | CompiledDocument;
  params?: Record<string, unknown>;
  host?: RuntimeHost;
  /** Version ref, attached to events. */
  version?: string;
  app?: Record<string, unknown>;
  device?: DeviceInfo;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Everything one mounted screen needs: its store, scope resolution, the action runner and its
 * data sources. Framework-agnostic; `@wishyor/zyrox-react` renders on top of it.
 */
export class ScreenRuntime {
  readonly doc: CompiledDocument;
  readonly store: Store;
  readonly host: RuntimeHost;
  readonly version?: string;
  private readonly helpers: HelperTree;
  private readonly callable: WeakSet<object>;
  private readonly reported = new Set<string>();
  private readonly cleanups: (() => void)[] = [];
  private readonly dataState = new Map<
    string,
    {
      seq: number;
      deps: Set<string>;
      lastKey?: string;
      timer?: ReturnType<typeof setTimeout>;
      abort?: AbortController;
    }
  >();
  private readonly forms = new Map<string, FormEntry>();
  private active = false;
  /** Bumped on every start/stop, so late async results from a previous mount are ignored. */
  private generation = 0;

  constructor(options: ScreenRuntimeOptions) {
    this.doc = 'nodes' in options.document ? options.document : compileDocument(options.document);
    this.host = options.host ?? {};
    this.version = options.version;
    const source = this.doc.source;
    const params: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(source.params ?? {})) {
      if (def.default !== undefined) params[name] = def.default;
    }
    Object.assign(params, options.params);
    const data: Record<string, unknown> = {};
    if (this.host.mock) for (const ds of this.doc.data) data[ds.key] = ds.mock ?? null;
    this.store = new Store({
      state: structuredCloneJson(source.state ?? {}),
      data,
      loading: {},
      error: {},
      params,
      app: options.app ?? {},
      device: options.device ?? {
        platform: 'unknown',
        width: 0,
        height: 0,
        colorScheme: 'light',
        locale: 'en',
        direction: 'ltr',
      },
      i18n: this.host.i18n?.getSnapshot() ?? { locale: 'en', locales: ['en'], direction: 'ltr', revision: 0 },
      forms: {},
    });
    this.helpers = {
      ...createBuiltinHelpers(
        () => this.host.i18n?.locale ?? (this.store.get('device') as DeviceInfo | undefined)?.locale,
        () => this.host.i18n?.translator(),
      ),
      ...this.host.helpers,
    };
    this.callable = helperFunctions(this.helpers);
    this.initForms();
    for (const problem of this.doc.problems) {
      this.emit({
        type: 'error',
        kind: 'document',
        message: problem.message,
        nodeId: problem.nodeId,
        source: problem.source,
      });
    }
    for (const [name, def] of Object.entries(source.params ?? {})) {
      if (def.required && (params[name] === undefined || params[name] === null)) {
        this.emit({ type: 'error', kind: 'document', message: `Missing required param "${name}"` });
      }
    }
  }

  get key(): string {
    return this.doc.key;
  }

  // --- events ---

  emit(input: EventInput): void {
    const event = { screen: this.doc.key, version: this.version, time: Date.now(), ...input } as ZyroxEvent;
    if (this.host.debug) console.debug('[zyrox]', event.type, event);
    for (const observer of this.host.observers ?? []) {
      try {
        observer(event);
      } catch (err) {
        if (this.host.debug) console.warn('[zyrox] observer failed', err);
      }
    }
  }

  /** Reports an error once per key, so re-renders don't flood observers. */
  reportOnce(key: string, input: EventInput): void {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.emit(input);
  }

  // --- scope & evaluation ---

  lookup(name: string, frame: Frame | null): unknown {
    for (let f = frame; f; f = f.parent) {
      if (Object.hasOwn(f.vars, name)) return f.vars[name];
    }
    if (STORE_ROOT_SET.has(name)) return this.store.get(name);
    if (Object.hasOwn(this.helpers, name)) return this.helpers[name];
    return MISSING;
  }

  env(frame: Frame | null, track?: (path: string) => void): EvalEnv {
    return {
      lookup: (name) => this.lookup(name, frame),
      isCallable: (fn) => typeof fn === 'function' && this.callable.has(fn),
      track: track
        ? (path) => {
            const root = path.split('.', 1)[0]!;
            if (STORE_ROOT_SET.has(root) && !isShadowed(root, frame)) track(path);
          }
        : undefined,
    };
  }

  /** Evaluates a compiled value. Errors are reported (once per node and expression) and yield `undefined`. */
  evaluate(cv: CompiledValue, frame: Frame | null, track?: (path: string) => void, nodeId?: string): unknown {
    if (cv.k === 's') return cv.v;
    return evalValue(cv, this.env(frame, track), (err, source) => {
      const message = err instanceof Error ? err.message : String(err);
      this.reportOnce(`expr:${nodeId ?? ''}:${source}:${message}`, {
        type: 'error',
        kind: 'expression',
        message,
        source,
        nodeId,
      });
    });
  }

  getState(path?: string): unknown {
    return this.store.get(path ? `state.${path}` : 'state');
  }

  setState(path: string, value: unknown): void {
    this.store.set(`state.${path}`, value);
  }

  setRoot(root: 'params' | 'app' | 'device', value: unknown): void {
    this.store.set(root, value);
  }

  // --- forms ---

  private initForms(): void {
    for (const form of this.doc.forms) {
      this.forms.set(form.name, {
        form,
        touched: new Set(),
        submitted: false,
        server: {},
        deps: new Set(),
        initial: structuredCloneJson(this.getState(form.name) ?? {}),
      });
      this.validateForm(form.name);
    }
    if (!this.forms.size) return;
    // Revalidate when anything a form's rules read changes; drop API errors of edited fields.
    this.store.subscribe((changed) => {
      if (changed === 'forms' || changed.startsWith('forms.')) return;
      // Default and `zyrox.form.*` messages follow the language.
      const relocalized = changed === 'i18n' || changed.startsWith('i18n.');
      for (const [name, entry] of this.forms) {
        let dirty = false;
        for (const field of Object.keys(entry.server)) {
          // Errors for undeclared fields (e.g. a form-level message) clear on any edit of the form.
          const declared = entry.form.fields.some((f) => f.path === field);
          if (pathsOverlap(changed, declared ? `state.${name}.${field}` : `state.${name}`)) {
            delete entry.server[field];
            dirty = true;
          }
        }
        if (dirty || relocalized || [...entry.deps].some((dep) => pathsOverlap(changed, dep)))
          this.validateForm(name);
      }
    });
  }

  private formEntry(name: string): FormEntry {
    const entry = this.forms.get(name);
    if (!entry) throw new Error(`Unknown form "${name}"`);
    return entry;
  }

  /** The form and field a state path belongs to, if it's a declared form field. */
  formField(path: string): { form: string; field: string; required: boolean } | undefined {
    for (const [name, entry] of this.forms) {
      if (!path.startsWith(`${name}.`)) continue;
      const field = entry.form.fields.find((f) => f.path === path.slice(name.length + 1));
      if (field) return { form: name, field: field.path, required: field.required };
    }
    return undefined;
  }

  /** Marks a field as edited, so its error starts showing. */
  touch(path: string): void {
    const hit = this.formField(path);
    if (!hit) return;
    const entry = this.formEntry(hit.form);
    if (entry.touched.has(hit.field)) return;
    entry.touched.add(hit.field);
    this.validateForm(hit.form);
  }

  /** Re-checks every field of a form and publishes `forms.<name>`. */
  validateForm(name: string): FormSnapshot {
    const entry = this.formEntry(name);
    const deps = new Set<string>();
    const track = (path: string) => {
      if (!path.startsWith('forms')) deps.add(path);
    };
    const translator = this.host.i18n?.translator();
    const translate = translator
      ? (key: string, vars: Record<string, unknown>) =>
          translator.has(key) ? translator(key, vars) : undefined
      : undefined;
    const errors: Record<string, string | null> = {};
    const shown: Record<string, string | null> = {};
    const required: Record<string, boolean> = {};
    for (const field of entry.form.fields) {
      const statePath = `${name}.${field.path}`;
      deps.add(`state.${statePath}`);
      required[field.path] = field.required;
      let error: string | null = null;
      if (!field.when || this.evaluate(field.when, null, track)) {
        const value = this.getState(statePath);
        const rules = this.evaluate(field.rules, childFrame(null, { value }), track);
        error =
          entry.server[field.path] ??
          checkField(
            value,
            (rules && typeof rules === 'object' ? rules : {}) as Record<string, unknown>,
            translate,
          );
      }
      errors[field.path] = error;
      const visible =
        entry.form.show === 'submit' ? entry.submitted : entry.submitted || entry.touched.has(field.path);
      shown[field.path] = visible ? error : null;
    }
    // API errors for fields without rules still reach the document (and keep the form invalid).
    for (const [field, message] of Object.entries(entry.server)) {
      if (field in errors) continue;
      errors[field] = message;
      shown[field] = message;
    }
    entry.deps = deps;
    const snapshot: FormSnapshot = {
      errors,
      shown,
      touched: Object.fromEntries([...entry.touched].map((f) => [f, true])),
      required,
      submitted: entry.submitted,
      valid: Object.values(errors).every((e) => !e),
    };
    this.store.set(`forms.${name}`, snapshot);
    return snapshot;
  }

  /** Shows every error; resolves whether the form is valid. */
  submitForm(name: string): boolean {
    const entry = this.formEntry(name);
    entry.submitted = true;
    return this.validateForm(name).valid;
  }

  resetForm(name: string, values?: unknown): void {
    const entry = this.formEntry(name);
    entry.touched.clear();
    entry.submitted = false;
    entry.server = {};
    this.setState(name, structuredCloneJson(values ?? entry.initial));
    this.validateForm(name);
  }

  /** Errors from your API: `{ field: message }` or `[{ field, message }]`. */
  setFormErrors(name: string, errors: unknown): void {
    const entry = this.formEntry(name);
    const list = Array.isArray(errors)
      ? (errors as { field?: unknown; message?: unknown }[]).map((e) => [e.field, e.message])
      : Object.entries((errors && typeof errors === 'object' ? errors : {}) as Record<string, unknown>);
    entry.server = {};
    for (const [field, message] of list) {
      if (typeof field === 'string' && typeof message === 'string' && message)
        entry.server[field] = message.slice(0, 500);
    }
    entry.submitted = true;
    this.validateForm(name);
  }

  // --- actions ---

  /** Runs an action list in order. Resolves `false` when an unhandled action failed. */
  async run(
    actions: readonly CompiledAction[] | undefined,
    frame: Frame | null,
    event?: unknown,
    nodeId?: string,
  ): Promise<boolean> {
    if (!actions?.length) return true;
    const scope = childFrame(frame, { event });
    for (const action of actions) {
      if (!(await this.runOne(action, scope, nodeId))) return false;
    }
    return true;
  }

  private async runOne(action: CompiledAction, frame: Frame, nodeId?: string): Promise<boolean> {
    const start = now();
    const meta = nodeId ? this.doc.nodes.get(nodeId)?.meta : undefined;
    const done = (ok: boolean) => {
      this.emit({ type: 'action', action: action.do, ok, durationMs: now() - start, nodeId, meta });
      return ok;
    };
    try {
      const args = (this.evaluate(action.args, frame, undefined, nodeId) ?? {}) as Record<string, any>;
      switch (action.do) {
        case 'setState':
          this.setState(String(args.path), args.value === undefined ? null : args.value);
          return done(true);
        case 'navigate': {
          if (!this.host.navigate)
            throw new Error('No navigator configured: pass `navigate` to the provider');
          this.host.navigate(String(args.to), (args.params as Record<string, unknown>) ?? {}, {
            presentation: (args.presentation as Presentation) ?? 'push',
            ...(args.transition ? { transition: String(args.transition) } : {}),
          });
          return done(true);
        }
        case 'back':
          if (!this.host.back) throw new Error('No navigator configured: pass `back` to the provider');
          this.host.back(args.result);
          return done(true);
        case 'openUrl': {
          const url = String(args.url ?? '');
          const allowed = this.host.urlSchemes ?? ['https:', 'http:', 'mailto:', 'tel:'];
          const scheme = schemeOf(url);
          if (!scheme || !allowed.includes(scheme)) throw new Error(`URL scheme not allowed: ${url}`);
          if (!this.host.openUrl) throw new Error('No URL opener configured');
          await this.host.openUrl(url);
          return done(true);
        }
        case 'request':
          return await this.remote(action, frame, nodeId, done, () =>
            this.fetch({
              url: String(args.url ?? ''),
              method: (args.method as HttpMethod) ?? 'GET',
              headers: stringRecord(args.headers),
              body: args.body ?? undefined,
              source: 'request',
            }),
          );
        case 'call': {
          const call = this.host.callFunction;
          if (!call)
            throw new Error(
              'No function caller configured: set `endpoint` or `callFunction` on the provider',
            );
          const fnArgs = (args.args as Record<string, unknown>) ?? {};
          return await this.remote(action, frame, nodeId, done, () =>
            call(String(args.fn), fnArgs, { screen: this.doc.key, nodeId }).then((r) => this.takeActions(r)),
          );
        }
        case 'setLocale':
          if (!this.host.i18n) throw new Error('No i18n configured');
          await this.host.i18n.setLocale(String(args.locale));
          return done(true);
        case 'refresh':
          await this.refresh(args.data ? String(args.data) : undefined);
          return done(true);
        case 'validate':
          // An invalid form stops the action list, without counting as an error.
          return done(this.submitForm(String(args.form)));
        case 'resetForm':
          this.resetForm(String(args.form), args.values);
          return done(true);
        case 'setErrors':
          this.setFormErrors(String(args.form), args.errors);
          return done(true);
        case 'sheet': {
          const overlays = this.overlays();
          const content = args.content as Record<string, unknown> | undefined;
          const params = args.params as Record<string, unknown> | undefined;
          void overlays
            .sheet({
              ...(args.id !== undefined ? { id: String(args.id) } : {}),
              ...(args.screen !== undefined ? { screen: String(args.screen) } : {}),
              ...(action.literal?.document !== undefined
                ? { document: action.literal.document as Document }
                : {}),
              ...(params ? { params } : {}),
              ...(content
                ? {
                    content: {
                      title: optionalText(content.title),
                      message: optionalText(content.message),
                      image: optionalText(content.image),
                      buttons: buttonsOf(content.buttons),
                    },
                  }
                : {}),
              ...(args.title !== undefined ? { title: String(args.title) } : {}),
              ...(args.size ? { size: args.size as 'auto' | 'half' | 'full' } : {}),
              ...(args.dismissible !== undefined ? { dismissible: Boolean(args.dismissible) } : {}),
            })
            .then(async (result: SheetResult) => {
              if (result.button !== undefined)
                await this.run(action.nested?.[`content.buttons.${result.button}`], frame, result, nodeId);
              await this.run(action.onClose, frame, result.result, nodeId);
            });
          return done(true);
        }
        case 'closeSheet':
          this.overlays().closeSheet(args.id === undefined ? undefined : String(args.id), args.result);
          return done(true);
        case 'alert': {
          const pressed = await this.overlays().alert({
            title: String(args.title ?? ''),
            message: optionalText(args.message),
            buttons: buttonsOf(args.buttons),
          });
          done(true);
          if (pressed === undefined) return true;
          return this.run(action.nested?.[`buttons.${pressed}`], frame, pressed, nodeId);
        }
        case 'toast': {
          const tone = args.tone as 'info' | 'success' | 'warning' | 'danger' | undefined;
          const button = args.action as { label?: unknown } | undefined;
          void this.overlays()
            .toast({
              message: String(args.message ?? ''),
              ...(tone ? { tone } : {}),
              ...(typeof args.duration === 'number' ? { duration: args.duration } : {}),
              ...(button ? { action: { label: String(button.label ?? '') } } : {}),
            })
            .then((pressed) => (pressed ? this.run(action.nested?.action, frame, true, nodeId) : true));
          return done(true);
        }
        case 'track':
          this.emit({
            type: 'track',
            name: String(args.event),
            props: (args.props as Record<string, unknown>) ?? {},
            nodeId,
            meta,
          });
          return done(true);
        case 'if': {
          const branch = args.cond ? action.then : action.else;
          done(true);
          return this.run(branch, frame, this.lookup('event', frame), nodeId);
        }
        default: {
          const handler = this.host.actions?.[action.do];
          if (!handler) throw new Error(`Unknown action "${action.do}"`);
          await handler(args, this.actionContext(frame, nodeId));
          return done(true);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'error', kind: 'action', message, nodeId, meta, source: action.do });
      return done(false);
    }
  }

  /** Shared flow of `request` and `call`: write `into`, then run `onSuccess` or `onError`. */
  private async remote(
    action: CompiledAction,
    frame: Frame,
    nodeId: string | undefined,
    done: (ok: boolean) => boolean,
    perform: () => Promise<unknown>,
  ): Promise<boolean> {
    let result: unknown;
    try {
      result = await perform();
    } catch (err) {
      this.takeErrorActions(err);
      if (!action.onError) throw err;
      done(false);
      return this.run(action.onError, frame, errorPayload(err), nodeId);
    }
    const into = (this.evaluate(action.args, frame, undefined, nodeId) as Record<string, unknown> | undefined)
      ?.into;
    if (into) this.setState(String(into), result);
    done(true);
    return this.run(action.onSuccess, frame, result, nodeId);
  }

  private actionContext(frame: Frame, nodeId?: string): HostActionContext {
    return {
      screen: this.doc.key,
      nodeId,
      event: this.lookup('event', frame),
      getState: (path) => this.getState(path),
      setState: (path, value) => this.setState(path, value),
      navigate: (to, params = {}, options = {}) =>
        this.host.navigate?.(to, params, { presentation: 'push', ...options }),
      track: (name, props = {}) => this.emit({ type: 'track', name, props, nodeId }),
      refresh: (key) => this.refresh(key),
    };
  }

  // --- requests & data sources ---

  resolveUrl(url: string): string {
    const base = this.host.apiBaseUrl;
    const origin = originOf(url);
    if (origin) {
      const allowed = [
        ...(base && originOf(base) ? [originOf(base)!] : []),
        ...(this.host.allowedOrigins ?? []).map((o) => o.toLowerCase()),
      ];
      if (!allowed.includes(origin)) throw new Error(`Request origin not allowed: ${origin}`);
      return url;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//'))
      throw new Error(`Request URL not allowed: ${url}`);
    if (!base) return url;
    return `${base.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
  }

  async fetch(request: Omit<FetchRequest, 'url'> & { url: string }): Promise<unknown> {
    const fetcher = this.host.fetcher ?? defaultFetcher;
    return this.takeActions(await fetcher({ ...request, url: this.resolveUrl(request.url) }));
  }

  private overlays(): OverlayHost {
    if (!this.host.overlays)
      throw new Error(
        'No overlays: pass `overlays` to the provider (e.g. from "@wishyor/zyrox-react/overlays")',
      );
    return this.host.overlays;
  }

  // --- actions from your backend ---

  /**
   * Runs actions your backend sent (`$actions` in a response, a stream or push message): taken
   * literally (no expressions) unless `expressions` is set (trigger rules), and only those in
   * `remoteActions`. A list with any other action is rejected as a whole. Resolves `false` when
   * rejected or when an action failed.
   */
  async runRemote(actions: unknown, event?: unknown, expressions = false): Promise<boolean> {
    if (
      !Array.isArray(actions) ||
      !actions.every((a) => a && typeof a === 'object' && typeof a.do === 'string')
    ) {
      this.emit({ type: 'error', kind: 'action', message: 'Backend actions must be a list of { do, … }' });
      return false;
    }
    const problems: { message: string }[] = [];
    const compiled = compileActions(actions as Action[], problems, undefined, !expressions);
    if (problems.length) {
      this.emit({ type: 'error', kind: 'action', message: problems[0]!.message });
      return false;
    }
    const allowed = new Set(this.host.remoteActions ?? DEFAULT_REMOTE_ACTIONS);
    const blocked = namesOf(compiled).find((name) => !allowed.has(name));
    if (blocked) {
      this.emit({
        type: 'error',
        kind: 'action',
        message: `Action "${blocked}" is not allowed from a backend (add it to remoteActions)`,
        source: blocked,
      });
      return false;
    }
    return this.run(compiled, null, event);
  }

  /** Strips `$actions` off a response and runs them. */
  private takeActions(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('$actions' in value)) return value;
    const { $actions, ...rest } = value as Record<string, unknown>;
    void this.runRemote($actions);
    return rest;
  }

  /** Error bodies can carry `$actions` too, e.g. a 401 that redirects to sign-in. */
  private takeErrorActions(err: unknown): void {
    const holder = err as { body?: unknown } | null;
    if (!holder || typeof holder !== 'object' || !holder.body) return;
    const body = this.takeActions(holder.body);
    try {
      holder.body = body;
    } catch {
      // A frozen error object keeps its body.
    }
  }

  /** Starts data sources: initial fetch, reactive refetch, polling and foreground refresh. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.generation++;
    const i18n = this.host.i18n;
    if (i18n) {
      const sync = () => this.store.set('i18n', i18n.getSnapshot());
      sync();
      this.cleanups.push(i18n.subscribe(sync));
    }
    if (this.host.mock) return;
    for (const ds of this.doc.data) {
      const state = { seq: 0, deps: new Set<string>() };
      this.dataState.set(ds.key, state);
      if (ds.refresh.includes('mount')) void this.load(ds);
      this.cleanups.push(
        this.store.watch(
          () => state.deps,
          () => this.schedule(ds),
        ),
      );
      for (const trigger of ds.refresh) {
        if (typeof trigger === 'number') {
          const id = setInterval(() => void this.load(ds, true), trigger * 1000);
          this.cleanups.push(() => clearInterval(id));
        } else if (trigger === 'foreground' && this.host.onForeground) {
          this.cleanups.push(this.host.onForeground(() => void this.load(ds, true)));
        }
      }
    }
  }

  /** Stops data sources. Safe to call more than once; `start()` may be called again later. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.generation++;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    for (const state of this.dataState.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.abort?.abort();
      state.lastKey = undefined;
    }
  }

  /** Re-fetches one data source, or all of them. */
  async refresh(key?: string): Promise<void> {
    const sources = this.doc.data.filter((ds) => key === undefined || ds.key === key);
    if (key !== undefined && sources.length === 0) throw new Error(`Unknown data source "${key}"`);
    if (this.host.mock) return;
    await Promise.all(sources.map((ds) => this.load(ds, true)));
  }

  private schedule(ds: CompiledDataSource): void {
    const state = this.dataState.get(ds.key);
    if (!state || !this.active) return;
    if (state.timer) clearTimeout(state.timer);
    if (ds.debounce > 0) state.timer = setTimeout(() => void this.load(ds), ds.debounce);
    else void this.load(ds);
  }

  private async load(ds: CompiledDataSource, force = false): Promise<void> {
    let state = this.dataState.get(ds.key);
    if (!state) {
      state = { seq: 0, deps: new Set() };
      this.dataState.set(ds.key, state);
    }
    if (!this.active) return;
    const generation = this.generation;
    const deps = new Set<string>();
    const track = (path: string) => {
      // A source never depends on its own result.
      if (
        !path.startsWith(`data.${ds.key}`) &&
        !path.startsWith(`loading.${ds.key}`) &&
        !path.startsWith(`error.${ds.key}`)
      )
        deps.add(path);
    };
    const enabled = ds.when ? Boolean(this.evaluate(ds.when, null, track)) : true;
    const request = this.evaluate(ds.request, null, track) as {
      url: unknown;
      method: HttpMethod;
      headers: unknown;
      body: unknown;
    };
    state.deps = deps;
    if (!enabled) return;
    const requestKey = JSON.stringify(request);
    if (!force && requestKey === state.lastKey) return;
    state.lastKey = requestKey;
    const seq = ++state.seq;
    state.abort?.abort();
    state.abort = undefined;
    const cache = ds.cache > 0 ? this.host.dataCache : undefined;
    const cacheKey = `${ds.kind ?? ''}\u0000${requestKey}`;
    const hit = cache?.get(cacheKey);
    if (hit) {
      // Stale-while-revalidate: show the cached response now; refetch only when it is old.
      this.store.set(`data.${ds.key}`, hit.value);
      this.store.set(`error.${ds.key}`, null);
      if (!force && Date.now() - hit.at < ds.cache * 1000) {
        this.store.set(`loading.${ds.key}`, false);
        this.emit({ type: 'data_load', key: ds.key, ok: true, durationMs: 0, cached: true });
        return;
      }
    }
    const abort = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    state.abort = abort;
    const start = now();
    this.store.set(`loading.${ds.key}`, true);
    try {
      const result = await this.fetch({
        url: String(request.url ?? ''),
        method: request.method,
        headers: stringRecord(request.headers),
        body: request.body ?? undefined,
        kind: ds.kind,
        key: ds.key,
        source: 'data',
        signal: abort?.signal,
      });
      if (seq !== state.seq || generation !== this.generation) return;
      cache?.set(cacheKey, result);
      this.store.set(`data.${ds.key}`, result);
      this.store.set(`error.${ds.key}`, null);
      this.emit({ type: 'data_load', key: ds.key, ok: true, durationMs: now() - start });
    } catch (err) {
      this.takeErrorActions(err);
      if (seq !== state.seq || generation !== this.generation) return;
      const payload = errorPayload(err);
      this.store.set(`error.${ds.key}`, payload);
      this.emit({
        type: 'data_load',
        key: ds.key,
        ok: false,
        durationMs: now() - start,
        status: payload.status,
      });
      this.emit({ type: 'error', kind: 'data', message: payload.message, source: ds.key });
    } finally {
      if (seq === state.seq && generation === this.generation) this.store.set(`loading.${ds.key}`, false);
    }
  }
}

function optionalText(value: unknown): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : String(value);
}

function buttonsOf(value: unknown): OverlayButton[] {
  if (!Array.isArray(value)) return [];
  return value.map((b) => {
    const button = (b ?? {}) as { label?: unknown; style?: unknown };
    const style = ['primary', 'cancel', 'destructive'].includes(String(button.style))
      ? (button.style as OverlayButton['style'])
      : 'default';
    return { label: String(button.label ?? ''), style };
  });
}

/** Every action name in a list, including nested lists. */
function namesOf(actions: readonly CompiledAction[] | undefined, out: string[] = []): string[] {
  for (const action of actions ?? []) {
    out.push(action.do);
    for (const list of [action.then, action.else, action.onSuccess, action.onError, action.onClose])
      namesOf(list, out);
    for (const list of Object.values(action.nested ?? {})) namesOf(list, out);
  }
  return out;
}

function isShadowed(name: string, frame: Frame | null): boolean {
  for (let f = frame; f; f = f.parent) if (Object.hasOwn(f.vars, name)) return true;
  return false;
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) if (v !== null && v !== undefined) out[k] = String(v);
  }
  return out;
}

function errorPayload(err: unknown): { message: string; status?: number; body?: unknown } {
  if (err instanceof FetchError) return { message: err.message, status: err.status, body: err.body };
  if (err instanceof Error) {
    // Fetchers may throw their own error types: pick up `status` and `body` when present.
    const { status, body } = err as Error & { status?: unknown; body?: unknown };
    return {
      message: err.message,
      ...(typeof status === 'number' ? { status } : {}),
      ...(body !== undefined ? { body } : {}),
    };
  }
  return { message: String(err) };
}

function structuredCloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
