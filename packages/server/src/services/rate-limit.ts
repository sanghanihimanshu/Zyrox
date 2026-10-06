import type { Context, MiddlewareHandler } from 'hono';

/** Fixed-window counters in memory (per server instance). */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; reset: number }>();
  private sweptAt = Date.now();

  constructor(
    readonly limit: number,
    readonly windowMs = 60_000,
  ) {}

  /** Counts a hit; returns how long to wait (ms) when over the limit, else 0. */
  hit(key: string, now = Date.now()): number {
    if (now - this.sweptAt > this.windowMs) {
      for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
      this.sweptAt = now;
    }
    const entry = this.hits.get(key);
    if (!entry || entry.reset <= now) {
      this.hits.set(key, { count: 1, reset: now + this.windowMs });
      return 0;
    }
    entry.count++;
    return entry.count > this.limit ? entry.reset - now : 0;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}

/** The client's address: the socket's, or the first `X-Forwarded-For` hop behind a trusted proxy. */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return forwarded;
  }
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? 'local';
}

export function tooMany(c: Context, waitMs: number) {
  c.header('retry-after', String(Math.ceil(waitMs / 1000)));
  return c.json({ error: { message: 'Too many requests. Try again shortly.', code: 'rate_limited' } }, 429);
}

/** Limits requests per key (default: client IP) on the routes it's mounted on. */
export function rateLimit(
  limiter: RateLimiter,
  trustProxy: boolean,
  key: (c: Context) => string = (c) => clientIp(c, trustProxy),
): MiddlewareHandler {
  return async (c, next) => {
    const wait = limiter.hit(key(c));
    if (wait) return tooMany(c, wait);
    await next();
  };
}
