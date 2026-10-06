import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  json,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export type Role = 'viewer' | 'editor' | 'publisher' | 'admin';
/** `strings` documents hold one locale's translations and are versioned/released like screens. */
export type DocumentKind = 'screen' | 'block' | 'strings';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  /** Instance owner: admin of every project. */
  owner: boolean('owner').notNull().default(false),
  createdAt: created(),
});

export const sessions = pgTable('sessions', {
  /** sha256 of the session token. */
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: created(),
});

/** Personal access tokens for the CLI, CI and MCP clients. */
export const apiTokens = pgTable('api_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  /** Only this project (null: every project the user can access). */
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  /** At most this role (null: the user's role). */
  role: text('role').$type<Role>(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: created(),
});

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  defaultLocale: text('default_locale').notNull().default('en'),
  /** Optional preview route of the app, loaded in the dashboard canvas. */
  previewUrl: text('preview_url'),
  createdAt: created(),
});

export const members = pgTable(
  'members',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<Role>().notNull(),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] })],
);

export const environments = pgTable(
  'environments',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    publicKey: text('public_key').notNull().unique(),
    /** Seconds clients wait before refreshing the bootstrap. */
    ttl: integer('ttl').notNull().default(60),
    createdAt: created(),
  },
  (t) => [uniqueIndex('environments_project_key').on(t.projectId, t.key)],
);

export const documents = pgTable(
  'documents',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    kind: text('kind').$type<DocumentKind>().notNull(),
    title: text('title').notNull().default(''),
    description: text('description').notNull().default(''),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [uniqueIndex('documents_project_key').on(t.projectId, t.key)],
);

export const drafts = pgTable('drafts', {
  documentId: text('document_id')
    .primaryKey()
    .references(() => documents.id, { onDelete: 'cascade' }),
  /** `json` (not `jsonb`) keeps key order: props and node keys stay as authors wrote them. */
  content: json('content').notNull(),
  /** Incremented on every save; writers send the revision they edited (optimistic locking). */
  revision: integer('revision').notNull().default(1),
  updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const versions = pgTable(
  'versions',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    /** Content hash of `content`; the public, immutable URL of this version. */
    ref: text('ref').notNull(),
    /** What clients receive (blocks expanded). */
    content: json('content').notNull(),
    /** The draft as published, for restoring and diffing. */
    source: json('source').notNull(),
    message: text('message').notNull().default(''),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('versions_document_number').on(t.documentId, t.number),
    index('versions_ref').on(t.ref),
  ],
);

export interface ReleaseRule {
  id: string;
  name?: string;
  /** Expression over `client`, `attrs`, `user` and `locale`; empty means always. */
  when?: string;
  /** Percent of matching users (0–100), bucketed by user id. Default 100. */
  rollout?: number;
  versionId?: string;
  experimentId?: string;
}

export const releases = pgTable(
  'releases',
  {
    id: text('id').primaryKey(),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    defaultVersionId: text('default_version_id')
      .notNull()
      .references(() => versions.id),
    rules: jsonb('rules').$type<ReleaseRule[]>().notNull().default(sql`'[]'::jsonb`),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('releases_env_document').on(t.environmentId, t.documentId)],
);

export interface Variant {
  key: string;
  versionId: string;
  weight: number;
}

export const experiments = pgTable(
  'experiments',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull().default(''),
    status: text('status').$type<'draft' | 'running' | 'stopped'>().notNull().default('draft'),
    variants: jsonb('variants').$type<Variant[]>().notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex('experiments_project_key').on(t.projectId, t.key)],
);

/** Remote functions forwarded to your cloud (Lambda, Cloud Run, Firebase, Vercel…). */
export const functions = pgTable(
  'functions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    url: text('url').notNull(),
    /** HMAC secret used to sign requests (`x-zyrox-signature`). */
    secret: text('secret').notNull(),
    timeoutMs: integer('timeout_ms').notNull().default(10000),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: created(),
  },
  (t) => [uniqueIndex('functions_project_name').on(t.projectId, t.name)],
);

/** Outbound webhooks: your systems are notified of changes (publish, release, rollback…). */
export const webhooks = pgTable(
  'webhooks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    description: text('description').notNull().default(''),
    /** Event names (`document.publish`, `release.*`) or `*`. */
    events: jsonb('events').$type<string[]>().notNull().default(sql`'["*"]'::jsonb`),
    /** HMAC secret (sealed with the server secret key). */
    secret: text('secret').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: created(),
  },
  (t) => [index('webhooks_project').on(t.projectId)],
);

/** Recent delivery attempts per webhook, for debugging (pruned). */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    webhookId: text('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    /** HTTP status, or 0 when the request failed. */
    status: integer('status').notNull(),
    ok: boolean('ok').notNull(),
    attempt: integer('attempt').notNull(),
    error: text('error').notNull().default(''),
    durationMs: integer('duration_ms').notNull().default(0),
    createdAt: created(),
  },
  (t) => [index('webhook_deliveries_webhook_created').on(t.webhookId, t.createdAt)],
);

export const manifests = pgTable(
  'manifests',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    hash: text('hash').notNull(),
    /** `json` keeps prop order, which the dashboard's property forms follow. */
    content: json('content').notNull(),
    /** Free-form label from the CLI, e.g. an app version or commit. */
    label: text('label').notNull().default(''),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.hash] })],
);

export const manifestTraffic = pgTable(
  'manifest_traffic',
  {
    environmentId: text('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    hash: text('hash').notNull(),
    day: text('day').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.environmentId, t.hash, t.day] })],
);

export const telemetry = pgTable(
  'telemetry',
  {
    environmentId: text('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    day: text('day').notNull(),
    /** `screen_view`, `error`, `exposure`, `function` */
    type: text('type').notNull(),
    /** Document key or function name. */
    subject: text('subject').notNull(),
    /** Version ref, experiment variant, or '' */
    ref: text('ref').notNull().default(''),
    /** Error kind, `ok`/`error` for functions, or '' */
    kind: text('kind').notNull().default(''),
    nodeId: text('node_id').notNull().default(''),
    message: text('message').notNull().default(''),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.environmentId, t.day, t.type, t.subject, t.ref, t.kind, t.nodeId] })],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    target: text('target').notNull().default(''),
    details: jsonb('details').notNull().default(sql`'{}'::jsonb`),
    createdAt: created(),
  },
  (t) => [index('audit_project_created').on(t.projectId, t.createdAt)],
);
