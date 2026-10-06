import { and, desc, eq, notInArray } from 'drizzle-orm';
import type { ServerContext } from '../context';
import { newId } from '../crypto';
import { projects, users, webhookDeliveries, webhooks } from '../db/schema';
import { signatureHeaders } from './functions';
import { safeRequest } from './safe-fetch';

/** What your endpoint receives (POST, JSON), signed like webhook functions. */
export interface WebhookPayload {
  /** Same for every retry of one event: use it to ignore duplicates. */
  id: string;
  /** `document.publish`, `release.set`, `release.rollback`… (the audit log action), or `ping`. */
  event: string;
  project: { id: string; slug: string };
  actor: { id: string; email: string } | null;
  /** What changed, e.g. the document key or `environment:document`. */
  target: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface DeliveryResult {
  status: number;
  ok: boolean;
  error: string;
  durationMs: number;
}

type WebhookRow = typeof webhooks.$inferSelect;

/** Default retry delays after a failed attempt: 10 s, 1 min, 5 min. */
export const DEFAULT_RETRY_DELAYS = [10_000, 60_000, 300_000];
const KEEP_DELIVERIES = 100;
const TIMEOUT_MS = 10_000;

/** `*`, an exact name, or a prefix pattern like `release.*`. */
export function eventMatches(patterns: readonly string[], event: string): boolean {
  return patterns.some(
    (p) => p === '*' || p === event || (p.endsWith('.*') && event.startsWith(p.slice(0, -1))),
  );
}

/**
 * Sends project events to the project's webhooks: in the background, signed, SSRF-protected,
 * retried with backoff, and logged per webhook.
 */
export class WebhookDispatcher {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(private readonly ctx: ServerContext) {}

  private get retryDelays(): readonly number[] {
    return this.ctx.options.webhookRetryDelays ?? DEFAULT_RETRY_DELAYS;
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => {});
    return promise;
  }

  /** Called for every audited change. Never throws; never delays the request that caused it. */
  dispatch(
    projectId: string,
    actorId: string | null,
    event: string,
    target: string,
    details: Record<string, unknown>,
  ): void {
    if (this.stopped) return;
    void this.track(
      this.fanOut(projectId, actorId, event, target, details).catch((err) => {
        console.warn('[zyrox] webhook dispatch failed', err);
      }),
    );
  }

  private async fanOut(
    projectId: string,
    actorId: string | null,
    event: string,
    target: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const hooks = (
      await this.ctx.db
        .select()
        .from(webhooks)
        .where(and(eq(webhooks.projectId, projectId), eq(webhooks.enabled, true)))
    ).filter((hook) => eventMatches(hook.events, event));
    if (!hooks.length) return;
    const payload = await this.payload(projectId, actorId, event, target, details);
    await Promise.all(hooks.map((hook) => this.attempt(hook, payload, 1)));
  }

  async payload(
    projectId: string,
    actorId: string | null,
    event: string,
    target: string,
    details: Record<string, unknown>,
  ): Promise<WebhookPayload> {
    const [project] = await this.ctx.db
      .select({ id: projects.id, slug: projects.slug })
      .from(projects)
      .where(eq(projects.id, projectId));
    const [actor] = actorId
      ? await this.ctx.db
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(eq(users.id, actorId))
      : [];
    return {
      id: newId('evt'),
      event,
      project: project ?? { id: projectId, slug: '' },
      actor: actor ?? null,
      target,
      details,
      createdAt: new Date().toISOString(),
    };
  }

  /** One signed POST. */
  async send(hook: WebhookRow, payload: WebhookPayload): Promise<DeliveryResult> {
    const body = JSON.stringify(payload);
    const start = Date.now();
    try {
      const res = await safeRequest(
        hook.url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'Zyrox-Webhooks/1',
            'x-zyrox-event': payload.event,
            'x-zyrox-delivery': payload.id,
            ...signatureHeaders(this.ctx.secrets.open(hook.secret), body),
          },
          body,
          timeoutMs: TIMEOUT_MS,
        },
        Boolean(this.ctx.options.allowPrivateUrls),
      );
      const ok = res.status >= 200 && res.status < 300;
      return {
        status: res.status,
        ok,
        error: ok ? '' : res.text.slice(0, 300),
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        status: 0,
        ok: false,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
        durationMs: Date.now() - start,
      };
    }
  }

  /** Sends, records the attempt, and (unless `retry` is off) schedules a retry when it failed. */
  async attempt(
    hook: WebhookRow,
    payload: WebhookPayload,
    attempt: number,
    retry = true,
  ): Promise<DeliveryResult> {
    const result = await this.send(hook, payload);
    await this.record(hook.id, payload.event, attempt, result);
    const delay = this.retryDelays[attempt - 1];
    if (retry && !result.ok && delay !== undefined && !this.stopped) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        void this.track(this.retry(hook.id, payload, attempt + 1));
      }, delay);
      (timer as { unref?: () => void }).unref?.();
      this.timers.add(timer);
    }
    return result;
  }

  private async retry(hookId: string, payload: WebhookPayload, attempt: number): Promise<void> {
    // The webhook may have been disabled or deleted meanwhile.
    const [hook] = await this.ctx.db.select().from(webhooks).where(eq(webhooks.id, hookId));
    if (hook?.enabled) await this.attempt(hook, payload, attempt);
  }

  private async record(
    hookId: string,
    event: string,
    attempt: number,
    result: DeliveryResult,
  ): Promise<void> {
    try {
      await this.ctx.db.insert(webhookDeliveries).values({
        id: newId('dlv'),
        webhookId: hookId,
        event,
        attempt,
        status: result.status,
        ok: result.ok,
        error: result.error,
        durationMs: result.durationMs,
      });
      const keep = this.ctx.db
        .select({ id: webhookDeliveries.id })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.webhookId, hookId))
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(KEEP_DELIVERIES);
      await this.ctx.db
        .delete(webhookDeliveries)
        .where(and(eq(webhookDeliveries.webhookId, hookId), notInArray(webhookDeliveries.id, keep)));
    } catch (err) {
      // The webhook was deleted while delivering.
      if (this.ctx.options.debug) console.warn('[zyrox] webhook delivery log failed', err);
    }
  }

  /** Resolves when nothing is being delivered right now (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
