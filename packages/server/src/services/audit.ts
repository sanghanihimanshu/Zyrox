import { newId } from '../crypto';
import type { Db } from '../db';
import { auditLog } from '../db/schema';

export type AuditSink = (
  projectId: string,
  actorId: string | null,
  action: string,
  target: string,
  details: Record<string, unknown>,
) => void;

const sinks = new WeakMap<object, AuditSink>();

/** Receives every audited change of a database (the server turns them into webhook events). */
export function onAudit(db: Db, sink: AuditSink): void {
  sinks.set(db, sink);
}

export async function audit(
  db: Db,
  projectId: string,
  actorId: string | null,
  action: string,
  target = '',
  details: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(auditLog).values({ id: newId('aud'), projectId, actorId, action, target, details });
  sinks.get(db)?.(projectId, actorId, action, target, details);
}
