import { sql } from 'drizzle-orm';
import { today } from '../crypto';
import type { Db } from '../db';
import { manifestTraffic, telemetry } from '../db/schema';

interface TelemetryRow {
  environmentId: string;
  type: string;
  subject: string;
  ref: string;
  kind: string;
  nodeId: string;
  message: string;
}

/**
 * Buffers counters in memory and writes them in batches, so hot endpoints (bootstrap, telemetry)
 * don't write to the database on every request.
 */
export class Counters {
  private traffic = new Map<string, { environmentId: string; hash: string; day: string; count: number }>();
  private events = new Map<string, TelemetryRow & { day: string; count: number }>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly db: Db,
    intervalMs = 10_000,
  ) {
    if (intervalMs > 0) {
      this.timer = setInterval(() => void this.flush(), intervalMs);
      this.timer.unref?.();
    }
  }

  manifest(environmentId: string, hash: string, count = 1): void {
    const day = today();
    const key = `${environmentId}|${hash}|${day}`;
    const entry = this.traffic.get(key);
    if (entry) entry.count += count;
    else this.traffic.set(key, { environmentId, hash, day, count });
  }

  event(row: TelemetryRow, count = 1): void {
    const day = today();
    const key = JSON.stringify([
      row.environmentId,
      day,
      row.type,
      row.subject,
      row.ref,
      row.kind,
      row.nodeId,
    ]);
    const entry = this.events.get(key);
    if (entry) entry.count += count;
    else this.events.set(key, { ...row, day, count });
  }

  async flush(): Promise<void> {
    const traffic = [...this.traffic.values()];
    const events = [...this.events.values()];
    this.traffic.clear();
    this.events.clear();
    if (traffic.length) {
      await this.db
        .insert(manifestTraffic)
        .values(traffic)
        .onConflictDoUpdate({
          target: [manifestTraffic.environmentId, manifestTraffic.hash, manifestTraffic.day],
          set: { count: sql`${manifestTraffic.count} + excluded.count` },
        });
    }
    if (events.length) {
      await this.db
        .insert(telemetry)
        .values(events)
        .onConflictDoUpdate({
          target: [
            telemetry.environmentId,
            telemetry.day,
            telemetry.type,
            telemetry.subject,
            telemetry.ref,
            telemetry.kind,
            telemetry.nodeId,
          ],
          set: { count: sql`${telemetry.count} + excluded.count` },
        });
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}
