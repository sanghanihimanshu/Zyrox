import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema';

export type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export interface Database {
  db: Db;
  kind: 'postgres' | 'pglite';
  close(): Promise<void>;
}

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

/**
 * Opens the database and applies migrations.
 * - `postgres://…` URLs use Postgres (production).
 * - `memory://` runs an in-memory PGlite (tests).
 * - Anything else is a directory for an embedded PGlite (local development, small installs).
 */
export async function openDatabase(url: string): Promise<Database> {
  if (/^postgres(ql)?:\/\//.test(url)) {
    const client = postgres(url, { max: 10, onnotice: () => {} });
    const db = drizzlePostgres(client, { schema });
    await migratePostgres(db, { migrationsFolder });
    return { db: db as unknown as Db, kind: 'postgres', close: () => client.end() };
  }
  let client: PGlite;
  if (url === 'memory://') {
    client = new PGlite();
  } else {
    const dir = url.replace(/^file:\/\//, '');
    mkdirSync(dir, { recursive: true });
    client = new PGlite(dir);
  }
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder });
  return { db: db as unknown as Db, kind: 'pglite', close: () => client.close() };
}

export { schema };
