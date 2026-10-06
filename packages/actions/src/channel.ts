import type { UiAction, UiMessage } from './types';

/** Response headers for a server-sent events stream (proxies: don't buffer, don't transform). */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

/** One server-sent event frame. */
export function encodeSse(message: UiMessage, id?: string): string {
  const lines = JSON.stringify(message)
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n');
  return `${id !== undefined ? `id: ${id}\n` : ''}${lines}\n\n`;
}

export interface UiChannelOptions {
  /** Messages kept per key and replayed after a reconnect (`Last-Event-ID`). Default 50. */
  history?: number;
  /** Seconds a message stays replayable. Default 300. */
  historyTtl?: number;
  /** Keep-alive comment interval, milliseconds. Default 25000. */
  heartbeatMs?: number;
}

type Listener = (message: UiMessage, id: string) => void;

interface Entry {
  seq: number;
  id: string;
  message: UiMessage;
  at: number;
}

interface NodeRequest {
  headers: Record<string, string | string[] | undefined>;
  on(event: 'close', listener: () => void): unknown;
}

interface NodeResponse {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: string): unknown;
  end?(): unknown;
}

const BROADCAST = '*';

/**
 * In-process pub/sub for UI messages, keyed by whatever identifies a recipient (user id, device
 * id, topic). Serves server-sent events on web-standard servers (`sse()`: Hono, Next.js route
 * handlers, Bun, Deno, Workers) and Node (`pipe()`: Express, Fastify, node:http). With several
 * server instances, fan out through Redis/NATS and call `publish` on each instance.
 */
export class UiChannel {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly history = new Map<string, Entry[]>();
  private readonly options: Required<UiChannelOptions>;
  private readonly epoch = Date.now().toString(36);
  private seq = 0;

  constructor(options: UiChannelOptions = {}) {
    this.options = { history: 50, historyTtl: 300, heartbeatMs: 25_000, ...options };
  }

  /** Calls `listener` for messages to `key` (and broadcasts). Returns unsubscribe. */
  subscribe(key: string, listener: Listener): () => void {
    const set = this.listeners.get(key) ?? new Set<Listener>();
    this.listeners.set(key, set);
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(key);
    };
  }

  /** Sends a message (or a list of actions) to one or more keys. Returns the event id. */
  publish(keys: string | readonly string[], input: UiMessage | UiAction[]): string {
    const message: UiMessage = Array.isArray(input) ? { actions: input } : input;
    const seq = ++this.seq;
    const id = `${this.epoch}-${seq}`;
    const now = Date.now();
    for (const key of typeof keys === 'string' ? [keys] : keys) {
      const entries = (this.history.get(key) ?? []).filter(
        (e) => now - e.at < this.options.historyTtl * 1000,
      );
      entries.push({ seq, id, message, at: now });
      this.history.set(key, entries.slice(-this.options.history));
      for (const listener of this.listeners.get(key) ?? []) listener(message, id);
      if (key === BROADCAST)
        for (const [k, set] of this.listeners)
          if (k !== BROADCAST) for (const listener of set) listener(message, id);
    }
    return id;
  }

  /** Sends to everyone connected. */
  broadcast(input: UiMessage | UiAction[]): string {
    return this.publish(BROADCAST, input);
  }

  /** Open connections for a key, or in total. */
  connections(key?: string): number {
    if (key !== undefined) return this.listeners.get(key)?.size ?? 0;
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  /** Messages for `key` after `lastEventId` (from the same server process), oldest first. */
  replay(key: string, lastEventId: string | null | undefined): { id: string; message: UiMessage }[] {
    if (!lastEventId) return [];
    const [epoch, seq] = lastEventId.split('-');
    if (epoch !== this.epoch || !seq) return [];
    const after = Number.parseInt(seq, 10);
    const now = Date.now();
    return [
      ...(this.history.get(key) ?? []),
      ...(key === BROADCAST ? [] : (this.history.get(BROADCAST) ?? [])),
    ]
      .filter((e) => e.seq > after && now - e.at < this.options.historyTtl * 1000)
      .sort((a, b) => a.seq - b.seq)
      .map(({ id, message }) => ({ id, message }));
  }

  private open(
    key: string,
    lastEventId: string | null | undefined,
    write: (chunk: string) => void,
  ): () => void {
    write('retry: 3000\n\n');
    for (const { id, message } of this.replay(key, lastEventId)) write(encodeSse(message, id));
    const unsubscribe = this.subscribe(key, (message, id) => write(encodeSse(message, id)));
    const heartbeat = setInterval(() => write(': ping\n\n'), this.options.heartbeatMs);
    (heartbeat as { unref?: () => void }).unref?.();
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
  }

  /**
   * A server-sent events `Response` for `key`. Authenticate the request first, then derive `key`
   * from the session, never from the client's say-so.
   */
  sse(
    key: string,
    request?: { headers?: { get(name: string): string | null }; signal?: AbortSignal },
  ): Response {
    const encoder = new TextEncoder();
    let close = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const write = (chunk: string) => {
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            close();
          }
        };
        close = this.open(key, request?.headers?.get('last-event-id'), write);
        request?.signal?.addEventListener('abort', () => {
          close();
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        });
      },
      cancel: () => close(),
    });
    return new Response(stream, { headers: { ...SSE_HEADERS } });
  }

  /** Server-sent events on a Node response (Express, Fastify `reply.raw`, node:http). */
  pipe(key: string, req: NodeRequest, res: NodeResponse): void {
    res.writeHead(200, { ...SSE_HEADERS });
    const header = req.headers['last-event-id'];
    const close = this.open(key, Array.isArray(header) ? header[0] : header, (chunk) => {
      res.write(chunk);
    });
    req.on('close', close);
  }
}
