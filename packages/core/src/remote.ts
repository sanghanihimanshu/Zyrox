import type { ClientStorage } from './client';
import { type CompiledValue, compileValue } from './compile';
import { childFrame, type Observer, type ScreenRuntime, type ZyroxEvent } from './runtime';
import { parseUiMessage, timeOf, type UiMessage, type UiTrigger } from './ui-message';

export { parseUiMessage, type UiMessage, type UiTrigger } from './ui-message';

/**
 * Backend-triggered UI, for any backend: messages over the transport you already have (SSE,
 * WebSocket, push, polling, Firebase, Pusher…) and event-trigger rules evaluated on the device.
 * Actions run through an app-level runtime with the provider's navigator and overlays, limited to
 * `remoteActions`.
 */

/** Delivers messages: call `receive` with each one, return a function that disconnects. */
export type UiActionSource = (receive: (message: unknown) => void) => () => void;

export interface UiActionCenterOptions {
  /** App-level runtime: runs the actions, evaluates trigger conditions. */
  runtime: ScreenRuntime;
  /** Remembers message ids and fired `once`/`cooldown` triggers across launches. */
  storage?: ClientStorage;
  /** Every accepted message (logging). */
  onMessage?(message: UiMessage): void;
  now?(): number;
}

interface TriggerState {
  /** Last fire time per trigger id (persisted). */
  fired: Record<string, number>;
  /** Message ids already run, with their time (persisted, a week). */
  seen: Record<string, number>;
}

const STORAGE_KEY = 'zyrox.ui';
const SEEN_TTL = 7 * 24 * 3600_000;
const MAX_SEEN = 500;

interface CompiledTrigger {
  trigger: UiTrigger;
  when?: CompiledValue;
}

export class UiActionCenter {
  readonly runtime: ScreenRuntime;
  private readonly options: UiActionCenterOptions;
  private triggers: CompiledTrigger[] = [];
  private state: TriggerState = { fired: {}, seen: {} };
  private readonly loaded: Promise<void>;
  private readonly session = new Map<string, number>();
  private readonly running = new Set<string>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private currentScreen?: string;
  private appOpened = false;
  private appOpenPending = false;

  constructor(options: UiActionCenterOptions) {
    this.options = options;
    this.runtime = options.runtime;
    this.loaded = this.restore();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async restore(): Promise<void> {
    try {
      const raw = await this.options.storage?.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<TriggerState>;
        this.state = { fired: parsed.fired ?? {}, seen: parsed.seen ?? {} };
      }
    } catch {
      // Unreadable state starts fresh.
    }
  }

  private persist(): void {
    const now = this.now();
    const seen = Object.entries(this.state.seen)
      .filter(([, at]) => now - at < SEEN_TTL)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SEEN);
    this.state.seen = Object.fromEntries(seen);
    try {
      void this.options.storage?.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Storage full or unavailable: limits then only hold for this session.
    }
  }

  /** Handles one message from any source. Resolves when its actions finished. */
  async receive(input: unknown): Promise<void> {
    const message = parseUiMessage(input);
    if (!message) {
      this.runtime.emit({
        type: 'error',
        kind: 'action',
        message: 'Unrecognized UI message',
        source: 'remote',
      });
      return;
    }
    await this.loaded;
    const expires = timeOf(message.expiresAt);
    if (expires !== undefined && expires < this.now()) return;
    if (message.id !== undefined) {
      if (this.state.seen[message.id]) return;
      this.state.seen[message.id] = this.now();
      this.persist();
    }
    this.options.onMessage?.(message);
    if (message.triggers) this.setTriggers(message.triggers);
    if (message.actions) await this.runtime.runRemote(message.actions);
  }

  /** Replaces the trigger rules. */
  setTriggers(triggers: readonly UiTrigger[]): void {
    this.triggers = [];
    for (const trigger of triggers) {
      if (!trigger || typeof trigger.id !== 'string' || !Array.isArray(trigger.actions)) continue;
      const problems: { message: string }[] = [];
      const when = trigger.if !== undefined ? compileValue(trigger.if, problems) : undefined;
      if (problems.length) {
        this.runtime.emit({
          type: 'error',
          kind: 'expression',
          message: `Trigger "${trigger.id}": ${problems[0]!.message}`,
          source: trigger.if,
        });
        continue;
      }
      this.triggers.push({ trigger, when });
    }
    if (this.appOpenPending && this.triggers.length) {
      this.appOpenPending = false;
      this.dispatch({ on: 'app_open' });
    }
  }

  getTriggers(): UiTrigger[] {
    return this.triggers.map((t) => t.trigger);
  }

  /** Feeds app events (screen views, tracks) to the trigger rules. Add it to the observers. */
  observer: Observer = (event: ZyroxEvent) => {
    if (event.type === 'screen_view') {
      this.currentScreen = event.screen;
      this.dispatch({ on: 'screen_view', name: event.screen, screen: event.screen, params: event.params });
    } else if (event.type === 'track') {
      this.dispatch({
        on: 'track',
        name: event.name,
        screen: this.currentScreen,
        props: event.props,
      });
    }
  };

  /** The app started (fires `app_open` rules once their rules are loaded). */
  appOpen(): void {
    if (this.appOpened) return;
    this.appOpened = true;
    if (this.triggers.length) this.dispatch({ on: 'app_open' });
    else this.appOpenPending = true;
  }

  foreground(): void {
    this.dispatch({ on: 'foreground' });
  }

  private dispatch(event: {
    on: UiTrigger['on'];
    name?: string;
    screen?: string;
    params?: Record<string, unknown>;
    props?: Record<string, unknown>;
  }): void {
    const now = this.now();
    for (const { trigger, when } of this.triggers) {
      if (trigger.on !== event.on) continue;
      if (trigger.name !== undefined && trigger.name !== event.name) continue;
      if (trigger.screen !== undefined && trigger.screen !== (event.screen ?? this.currentScreen)) continue;
      if ((timeOf(trigger.startsAt) ?? -Infinity) > now || (timeOf(trigger.endsAt) ?? Infinity) < now)
        continue;
      if (this.running.has(trigger.id)) continue;
      const last = this.state.fired[trigger.id];
      if (trigger.once && last !== undefined) continue;
      if (trigger.cooldown && last !== undefined && now - last < trigger.cooldown * 1000) continue;
      if (trigger.maxPerSession !== undefined && (this.session.get(trigger.id) ?? 0) >= trigger.maxPerSession)
        continue;
      const scope = {
        type: event.on,
        name: event.name,
        screen: event.screen ?? this.currentScreen,
        params: event.params ?? {},
        props: event.props ?? {},
      };
      if (when && !this.runtime.evaluate(when, childFrame(null, { event: scope }))) continue;
      this.fire(trigger, scope);
    }
  }

  private fire(trigger: UiTrigger, event: { screen?: string }): void {
    this.state.fired[trigger.id] = this.now();
    this.session.set(trigger.id, (this.session.get(trigger.id) ?? 0) + 1);
    this.persist();
    const run = async () => {
      this.running.add(trigger.id);
      try {
        await this.runtime.runRemote(trigger.actions, event, true);
      } finally {
        this.running.delete(trigger.id);
      }
    };
    if (!trigger.delay) {
      void run();
      return;
    }
    const screen = this.currentScreen;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      // The user moved on: the moment has passed.
      if (this.currentScreen === screen) void run();
    }, trigger.delay);
    this.timers.add(timer);
  }

  /** Cancels delayed triggers. */
  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

// --- Server-sent events ------------------------------------------------------------------------

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/** Incremental `text/event-stream` parser: feed it chunks, get events. */
export function createSseParser(onEvent: (event: SseEvent) => void, onRetry?: (ms: number) => void) {
  let buffer = '';
  let data: string[] = [];
  let event = '';
  let id: string | undefined;
  return (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r\n|\r|\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line === '') {
        if (data.length) onEvent({ event: event || 'message', data: data.join('\n'), id });
        data = [];
        event = '';
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
      else if (field === 'id') id = value;
      else if (field === 'retry' && /^\d+$/.test(value)) onRetry?.(Number(value));
    }
  };
}

type Headers = Record<string, string>;

export interface ReconnectOptions {
  /** First reconnect delay, milliseconds. Default 1000. */
  minDelay?: number;
  /** Longest reconnect delay, milliseconds. Default 30000. */
  maxDelay?: number;
}

function backoff(options: ReconnectOptions) {
  const min = options.minDelay ?? 1000;
  const max = options.maxDelay ?? 30_000;
  let attempt = 0;
  return {
    next: () => Math.min(max, min * 2 ** attempt++) * (0.75 + Math.random() * 0.5),
    reset: () => {
      attempt = 0;
    },
  };
}

/** The parts of `XMLHttpRequest` the SSE source uses (browsers and React Native have it). */
export interface XhrLike {
  readonly readyState: number;
  readonly responseText: string;
  withCredentials: boolean;
  onprogress: ((...args: never[]) => unknown) | null;
  onreadystatechange: ((...args: never[]) => unknown) | null;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(): void;
  abort(): void;
}

export interface SseSourceOptions extends ReconnectOptions {
  /** Request headers, e.g. your auth token. Called on every (re)connect. */
  headers?: () => Headers | Promise<Headers>;
  withCredentials?: boolean;
  /** Only events with these names are messages. Default: `message` and `ui`. */
  events?: readonly string[];
  /** Reconnects after this many characters to bound memory. Default 1,000,000. */
  maxBuffer?: number;
  /** For tests or custom transports. Default: the global `XMLHttpRequest`. */
  createRequest?: () => XhrLike;
}

/**
 * Server-sent events over `XMLHttpRequest`, so it works in browsers and React Native alike and can
 * send auth headers. Reconnects with backoff and `Last-Event-ID`.
 */
export function sseSource(url: string | (() => string), options: SseSourceOptions = {}): UiActionSource {
  return (receive) => {
    const names = new Set(options.events ?? ['message', 'ui']);
    const retry = backoff(options);
    let closed = false;
    let xhr: XhrLike | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastId: string | undefined;
    let serverRetry: number | undefined;

    const schedule = () => {
      if (closed) return;
      timer = setTimeout(connect, serverRetry ?? retry.next());
    };

    const connect = async () => {
      if (closed) return;
      const headers = { ...(await options.headers?.()) };
      if (closed) return;
      const request =
        options.createRequest?.() ??
        new (globalThis as unknown as { XMLHttpRequest: new () => XhrLike }).XMLHttpRequest();
      xhr = request;
      let seen = 0;
      const parse = createSseParser(
        (event) => {
          if (event.id !== undefined) lastId = event.id;
          if (names.has(event.event)) receive(event.data);
        },
        (ms) => {
          serverRetry = ms;
        },
      );
      const read = () => {
        const text = request.responseText ?? '';
        if (text.length > seen) {
          retry.reset();
          parse(text.slice(seen));
          seen = text.length;
        }
        if (seen > (options.maxBuffer ?? 1_000_000)) request.abort();
      };
      request.open('GET', typeof url === 'function' ? url() : url);
      request.setRequestHeader('Accept', 'text/event-stream');
      request.setRequestHeader('Cache-Control', 'no-cache');
      if (lastId !== undefined) request.setRequestHeader('Last-Event-ID', lastId);
      for (const [k, v] of Object.entries(headers)) request.setRequestHeader(k, v);
      request.withCredentials = Boolean(options.withCredentials);
      request.onprogress = read;
      request.onreadystatechange = () => {
        if (request.readyState === 3 || request.readyState === 4) read();
        if (request.readyState === 4 && xhr === request) {
          xhr = undefined;
          schedule();
        }
      };
      request.send();
    };

    void connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      const open = xhr;
      xhr = undefined;
      open?.abort();
    };
  };
}

// --- WebSocket -----------------------------------------------------------------------------------

export interface WebSocketSourceOptions extends ReconnectOptions {
  protocols?: string | string[];
  /** After connecting, e.g. send an auth or subscribe message. */
  onOpen?(socket: WebSocket): void;
  /** For tests. Default: the global `WebSocket`. */
  createSocket?: (url: string, protocols?: string | string[]) => WebSocket;
}

/** JSON messages over a WebSocket, reconnecting with backoff. */
export function webSocketSource(
  url: string | (() => string),
  options: WebSocketSourceOptions = {},
): UiActionSource {
  return (receive) => {
    const retry = backoff(options);
    let closed = false;
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (closed) return;
      const target = typeof url === 'function' ? url() : url;
      const ws =
        options.createSocket?.(target, options.protocols) ?? new WebSocket(target, options.protocols);
      socket = ws;
      ws.onopen = () => {
        retry.reset();
        options.onOpen?.(ws);
      };
      ws.onmessage = (event) => {
        if (typeof event.data === 'string') receive(event.data);
      };
      ws.onclose = () => {
        if (socket !== ws || closed) return;
        socket = undefined;
        timer = setTimeout(connect, retry.next());
      };
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      socket?.close();
      socket = undefined;
    };
  };
}

// --- Polling -------------------------------------------------------------------------------------

/** Calls `load` now and every `interval` seconds; each result is a message (or list of them). */
export function pollSource(load: () => Promise<unknown>, options: { interval: number }): UiActionSource {
  return (receive) => {
    let stopped = false;
    const tick = () =>
      load().then(
        (result) => {
          if (stopped) return;
          for (const message of Array.isArray(result) && result.every(isMessageLike) ? result : [result])
            if (message) receive(message);
        },
        () => {},
      );
    void tick();
    const timer = setInterval(tick, Math.max(1, options.interval) * 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  };
}

function isMessageLike(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !('do' in value));
}
