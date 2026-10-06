import { documentJsonSchema } from '@zyrox/protocol';

/**
 * OpenAPI 3.1 description of the delivery API (`/v1`) and the admin API (`/api/v1`), served at
 * `/api/v1/openapi.json`. A test keeps it in sync with the routes the server registers.
 */

type Schema = Record<string, unknown>;
type Auth = 'publicKey' | 'user' | 'none';

interface Op {
  summary: string;
  tag: string;
  auth?: Auth;
  /** Minimum project role. */
  role?: 'viewer' | 'editor' | 'publisher' | 'admin';
  description?: string;
  query?: Record<string, Schema & { description?: string }>;
  headers?: Record<string, string>;
  body?: Schema;
  response?: Schema;
  status?: number;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
});
const str = (description?: string): Schema => ({ type: 'string', ...(description ? { description } : {}) });
const int = (description?: string): Schema => ({ type: 'integer', ...(description ? { description } : {}) });
const bool: Schema = { type: 'boolean' };
const list = (items: Schema): Schema => ({ type: 'array', items });
const any: Schema = {};
const ok = obj({ ok: { const: true } });

const clientHeaders = {
  'x-zyrox-client': 'platform=…;app=…;manifest=…;protocol=1 (URL-encoded pairs)',
  'x-zyrox-user': 'Stable user or install id for rollouts and experiments',
  'x-zyrox-attrs': 'Targeting attributes as URL-encoded pairs',
  'accept-language': 'Preferred locales',
  'x-zyrox-preview': 'Draft preview token (zpv_…): drafts instead of releases',
};

const P = '/api/v1/projects/{project}';
const D = `${P}/documents/{key}`;

const OPS: [string, string, Op][] = [
  ['get', '/healthz', { summary: 'Liveness check', tag: 'Server', auth: 'none', response: ok }],
  ['get', '/api/v1/openapi.json', { summary: 'This document', tag: 'Server', auth: 'none', response: any }],

  // --- Delivery (apps) ---
  [
    'get',
    '/v1/bootstrap',
    {
      summary: 'What this client should show: document and strings refs, experiments',
      description:
        'Per user (targeting, rollouts). Revalidate with If-None-Match; unchanged bootstraps are 304.',
      tag: 'Delivery',
      auth: 'publicKey',
      headers: clientHeaders,
      response: ref('Bootstrap'),
    },
  ],
  [
    'get',
    '/v1/screens/{key}',
    {
      summary: 'One screen as this client would get it (server-side rendering)',
      tag: 'Delivery',
      auth: 'publicKey',
      headers: clientHeaders,
      response: obj(
        {
          key: str(),
          ref: str('Content hash of the version'),
          document: ref('Document'),
          experiment: obj({ key: str(), variant: str() }),
          preview: bool,
        },
        ['key', 'ref', 'document'],
      ),
    },
  ],
  [
    'get',
    '/v1/docs/{ref}',
    {
      summary: 'An immutable document version (cache forever)',
      tag: 'Delivery',
      auth: 'none',
      response: ref('Document'),
    },
  ],
  [
    'get',
    '/v1/strings/{ref}',
    {
      summary: 'An immutable translations bundle (cache forever)',
      tag: 'Delivery',
      auth: 'none',
      response: any,
    },
  ],
  [
    'post',
    '/v1/functions/{name}',
    {
      summary: 'Call a remote function',
      tag: 'Delivery',
      auth: 'publicKey',
      headers: { ...clientHeaders, 'x-zyrox-user-token': "Your user's token, forwarded to the function" },
      body: obj({ args: { type: 'object' }, screen: str(), nodeId: str() }),
      response: obj({ result: any }),
    },
  ],
  [
    'post',
    '/v1/translate',
    {
      summary: 'Machine-translate missing strings (when runtime translation is on)',
      tag: 'Delivery',
      auth: 'publicKey',
      body: obj({ locale: str(), keys: list(str()) }, ['locale', 'keys']),
      response: obj({ messages: { type: 'object', additionalProperties: str() } }),
    },
  ],
  [
    'post',
    '/v1/telemetry',
    {
      summary: 'Aggregated screen views, errors and exposures',
      tag: 'Delivery',
      auth: 'publicKey',
      body: obj({
        events: list(obj({ type: { enum: ['screen_view', 'error', 'exposure'] }, count: int() })),
      }),
      response: ok,
    },
  ],

  // --- Auth ---
  [
    'get',
    '/api/v1/auth/status',
    { summary: 'Whether sign-up is open', tag: 'Auth', auth: 'none', response: any },
  ],
  [
    'post',
    '/api/v1/auth/signup',
    {
      summary: 'Create an account (the first one becomes the owner); sets the session cookie',
      tag: 'Auth',
      auth: 'none',
      body: obj({ email: str(), password: str(), name: str() }, ['email', 'password']),
      response: obj({ user: ref('User') }),
    },
  ],
  [
    'post',
    '/api/v1/auth/login',
    {
      summary: 'Sign in; sets the session cookie',
      tag: 'Auth',
      auth: 'none',
      body: obj({ email: str(), password: str() }, ['email', 'password']),
      response: obj({ user: ref('User') }),
    },
  ],
  ['post', '/api/v1/auth/logout', { summary: 'Sign out', tag: 'Auth', response: ok }],
  [
    'get',
    '/api/v1/me',
    { summary: 'The current user, their projects and token scope', tag: 'Auth', response: any },
  ],
  [
    'patch',
    '/api/v1/me',
    {
      summary: 'Update the current user profile',
      tag: 'Auth',
      body: obj({ name: str() }, ['name']),
      response: obj({ user: ref('User') }),
    },
  ],
  ['get', '/api/v1/tokens', { summary: 'Personal access tokens', tag: 'Auth', response: any }],
  [
    'post',
    '/api/v1/tokens',
    {
      summary: 'Create a personal access token (shown once)',
      tag: 'Auth',
      body: obj({
        name: str(),
        project: str('Limit to one project (slug)'),
        role: { enum: ['viewer', 'editor', 'publisher', 'admin'] },
        expiresInDays: int(),
      }),
      response: any,
      status: 201,
    },
  ],
  ['delete', '/api/v1/tokens/{id}', { summary: 'Revoke a token', tag: 'Auth', response: ok }],
  [
    'post',
    '/api/v1/users',
    {
      summary: 'Create a user (owner)',
      tag: 'Auth',
      body: obj({ email: str(), password: str() }),
      response: any,
    },
  ],

  // --- Projects ---
  [
    'post',
    '/api/v1/projects',
    {
      summary: 'Create a project',
      tag: 'Projects',
      body: obj({ name: str(), slug: str() }),
      response: any,
      status: 201,
    },
  ],
  [
    'get',
    P,
    {
      summary: 'A project with its environments and your role',
      tag: 'Projects',
      role: 'viewer',
      response: any,
    },
  ],
  [
    'patch',
    P,
    { summary: 'Update project settings', tag: 'Projects', role: 'admin', body: any, response: any },
  ],
  [
    'delete',
    P,
    { summary: 'Delete a project and its data', tag: 'Projects', role: 'admin', response: ok },
  ],
  [
    'patch',
    `${P}/environments/{env}`,
    { summary: 'Update an environment (TTL…)', tag: 'Projects', role: 'admin', body: any, response: any },
  ],
  ['get', `${P}/members`, { summary: 'Members and roles', tag: 'Projects', role: 'viewer', response: any }],
  [
    'put',
    `${P}/members`,
    {
      summary: 'Add a member or change a role',
      tag: 'Projects',
      role: 'admin',
      body: obj({ email: str(), role: str() }),
      response: any,
    },
  ],
  [
    'delete',
    `${P}/members/{userId}`,
    { summary: 'Remove a member', tag: 'Projects', role: 'admin', response: ok },
  ],
  ['get', `${P}/audit`, { summary: 'Audit log', tag: 'Projects', role: 'viewer', response: any }],
  [
    'get',
    `${P}/health`,
    { summary: 'Views, errors and exposures per version', tag: 'Projects', role: 'viewer', response: any },
  ],

  // --- Documents ---
  [
    'get',
    `${P}/documents`,
    { summary: 'Screens, blocks and string bundles', tag: 'Documents', role: 'viewer', response: any },
  ],
  [
    'post',
    `${P}/documents`,
    {
      summary: 'Create a document',
      tag: 'Documents',
      role: 'editor',
      body: obj({ key: str(), kind: { enum: ['screen', 'block', 'strings'] }, title: str(), content: any }, [
        'key',
        'kind',
      ]),
      response: any,
      status: 201,
    },
  ],
  [
    'get',
    D,
    {
      summary: 'A document with its draft and latest version',
      tag: 'Documents',
      role: 'viewer',
      response: any,
    },
  ],
  [
    'patch',
    D,
    { summary: 'Rename or describe a document', tag: 'Documents', role: 'editor', body: any, response: any },
  ],
  ['delete', D, { summary: 'Archive a document', tag: 'Documents', role: 'editor', response: ok }],
  [
    'put',
    `${D}/draft`,
    {
      summary: 'Replace the draft (optimistic locking with revision)',
      tag: 'Documents',
      role: 'editor',
      body: obj({ content: ref('Document'), revision: int() }, ['content']),
      response: any,
    },
  ],
  [
    'post',
    `${D}/ops`,
    {
      summary: 'Apply ops to the draft (insert, update, remove, move, doc)',
      tag: 'Documents',
      role: 'editor',
      body: obj({ ops: list({ type: 'object' }), revision: int() }, ['ops']),
      response: any,
    },
  ],
  [
    'post',
    `${D}/validate`,
    {
      summary: 'Problems and app-build compatibility of the draft',
      tag: 'Documents',
      role: 'viewer',
      body: any,
      response: any,
    },
  ],
  [
    'post',
    `${D}/publish`,
    {
      summary: 'Publish the draft as a new version and optionally release it',
      tag: 'Documents',
      role: 'publisher',
      body: obj({ message: str(), release: list(str('Environment key')), revision: int() }),
      response: any,
    },
  ],
  ['get', `${D}/versions`, { summary: 'Version history', tag: 'Documents', role: 'viewer', response: any }],
  [
    'get',
    `${D}/versions/{number}`,
    { summary: 'One version', tag: 'Documents', role: 'viewer', response: any },
  ],
  [
    'post',
    `${D}/versions/{number}/restore`,
    { summary: 'Restore a version into the draft', tag: 'Documents', role: 'editor', response: any },
  ],

  // --- Releases & experiments ---
  [
    'get',
    `${P}/environments/{env}/releases`,
    {
      summary: 'What each document serves in an environment',
      tag: 'Releases',
      role: 'viewer',
      response: any,
    },
  ],
  [
    'put',
    `${P}/environments/{env}/releases/{key}`,
    {
      summary: 'Release a version, with targeting rules and rollouts',
      tag: 'Releases',
      role: 'publisher',
      body: obj({ version: int(), rules: list({ type: 'object' }) }),
      response: any,
    },
  ],
  [
    'post',
    `${P}/environments/{env}/releases/{key}/rollback`,
    { summary: 'Roll back to the previous version', tag: 'Releases', role: 'publisher', response: any },
  ],
  [
    'delete',
    `${P}/environments/{env}/releases/{key}`,
    { summary: 'Stop serving a document', tag: 'Releases', role: 'publisher', response: ok },
  ],
  [
    'post',
    `${P}/promote`,
    {
      summary: 'Copy releases from one environment to another',
      tag: 'Releases',
      role: 'publisher',
      body: obj({ from: str(), to: str(), documents: list(str()) }, ['from', 'to']),
      response: any,
    },
  ],
  ['get', `${P}/experiments`, { summary: 'Experiments', tag: 'Releases', role: 'viewer', response: any }],
  [
    'post',
    `${P}/experiments`,
    {
      summary: 'Create an experiment',
      tag: 'Releases',
      role: 'publisher',
      body: any,
      response: any,
      status: 201,
    },
  ],
  [
    'patch',
    `${P}/experiments/{key}`,
    { summary: 'Update or stop an experiment', tag: 'Releases', role: 'publisher', body: any, response: any },
  ],

  // --- Manifests & functions ---
  [
    'post',
    `${P}/manifests`,
    {
      summary: 'Upload an app build manifest (components, actions)',
      tag: 'Manifests',
      role: 'editor',
      body: any,
      response: any,
    },
  ],
  [
    'get',
    `${P}/manifests`,
    { summary: 'Manifests with their share of traffic', tag: 'Manifests', role: 'viewer', response: any },
  ],
  ['get', `${P}/functions`, { summary: 'Remote functions', tag: 'Functions', role: 'viewer', response: any }],
  [
    'post',
    `${P}/functions`,
    {
      summary: 'Register a webhook function (secret shown once)',
      tag: 'Functions',
      role: 'admin',
      body: obj({ name: str(), url: str(), timeoutMs: int() }, ['name', 'url']),
      response: any,
      status: 201,
    },
  ],
  [
    'patch',
    `${P}/functions/{name}`,
    { summary: 'Update or rotate the secret', tag: 'Functions', role: 'admin', body: any, response: any },
  ],
  [
    'delete',
    `${P}/functions/{name}`,
    { summary: 'Remove a function', tag: 'Functions', role: 'admin', response: ok },
  ],
  [
    'post',
    `${P}/functions/{name}/test`,
    { summary: 'Call a function with test args', tag: 'Functions', role: 'editor', body: any, response: any },
  ],

  // --- Webhooks ---
  [
    'get',
    `${P}/webhooks`,
    {
      summary: 'Outbound webhooks with their last delivery',
      tag: 'Webhooks',
      role: 'admin',
      response: obj({ webhooks: list(ref('Webhook')) }),
    },
  ],
  [
    'post',
    `${P}/webhooks`,
    {
      summary: 'Notify a URL of project events (secret shown once)',
      description:
        'Events are audit actions: document.publish, release.set, release.rollback, release.promote, experiment.update, function.update… Use "*" or prefixes like "release.*".',
      tag: 'Webhooks',
      role: 'admin',
      body: obj({ url: str(), events: list(str()), description: str(), enabled: bool }, ['url']),
      response: obj({ webhook: ref('Webhook') }),
      status: 201,
    },
  ],
  [
    'patch',
    `${P}/webhooks/{id}`,
    {
      summary: 'Update a webhook or rotate its secret',
      tag: 'Webhooks',
      role: 'admin',
      body: obj({ url: str(), events: list(str()), description: str(), enabled: bool, rotateSecret: bool }),
      response: obj({ webhook: ref('Webhook') }),
    },
  ],
  [
    'delete',
    `${P}/webhooks/{id}`,
    { summary: 'Remove a webhook', tag: 'Webhooks', role: 'admin', response: ok },
  ],
  [
    'post',
    `${P}/webhooks/{id}/test`,
    { summary: 'Send a signed ping now', tag: 'Webhooks', role: 'admin', response: any },
  ],
  [
    'get',
    `${P}/webhooks/{id}/deliveries`,
    { summary: 'Recent delivery attempts', tag: 'Webhooks', role: 'admin', response: any },
  ],

  // --- Preview, export, AI ---
  [
    'post',
    `${P}/preview-sessions`,
    {
      summary: 'Start a live preview session for devices (QR)',
      tag: 'Preview',
      role: 'editor',
      body: any,
      response: any,
    },
  ],
  [
    'post',
    `${P}/preview-tokens`,
    {
      summary: 'A draft preview token for app builds and SSR draft mode',
      description:
        'Send it as x-zyrox-preview (client option previewToken): drafts are served instead of releases.',
      tag: 'Preview',
      role: 'editor',
      body: obj({ expiresInMinutes: int(), documents: list(str()) }),
      response: obj({ token: str(), expiresAt: str() }, ['token', 'expiresAt']),
      status: 201,
    },
  ],
  [
    'get',
    `${P}/export`,
    {
      summary: 'Export drafts and settings (and with versions=true, history and releases)',
      tag: 'Export',
      role: 'admin',
      query: { versions: { type: 'boolean', description: 'Include version history and releases' } },
      response: ref('ProjectExport'),
    },
  ],
  [
    'post',
    `${P}/import`,
    {
      summary: 'Import an export into this project',
      tag: 'Export',
      role: 'admin',
      body: obj({ bundle: ref('ProjectExport'), overwrite: bool }, ['bundle']),
      response: any,
    },
  ],
  [
    'get',
    '/api/v1/ai/status',
    { summary: 'Whether the AI assistant is configured', tag: 'AI', response: any },
  ],
  [
    'post',
    `${D}/ai`,
    {
      summary: 'Ask the assistant to edit a draft (streamed)',
      tag: 'AI',
      role: 'editor',
      body: any,
      response: any,
    },
  ],
  [
    'post',
    `${P}/translate`,
    {
      summary: 'Machine-translate missing strings of a locale',
      tag: 'AI',
      role: 'editor',
      body: any,
      response: any,
    },
  ],
];

function operation(method: string, path: string, op: Op): Schema {
  const auth = op.auth ?? 'user';
  const parameters = [
    ...[...path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    })),
    ...Object.entries(op.query ?? {}).map(([name, schema]) => ({ name, in: 'query', schema })),
    ...Object.entries(op.headers ?? {}).map(([name, description]) => ({
      name,
      in: 'header',
      description,
      schema: { type: 'string' },
    })),
  ];
  return {
    operationId: `${method}${path
      .replace(/^\/api\/v1|^\/v1/, '')
      .replace(/\{(\w+)\}/g, 'By$1')
      .split(/[/._-]+/)
      .filter(Boolean)
      .map((s) => s[0]!.toUpperCase() + s.slice(1))
      .join('')}`,
    summary: op.summary,
    ...(op.description || op.role
      ? {
          description: [op.description, op.role ? `Requires the ${op.role} role.` : '']
            .filter(Boolean)
            .join(' '),
        }
      : {}),
    tags: [op.tag],
    ...(parameters.length ? { parameters } : {}),
    security:
      auth === 'none' ? [] : auth === 'publicKey' ? [{ publicKey: [] }] : [{ token: [] }, { session: [] }],
    ...(op.body
      ? { requestBody: { required: true, content: { 'application/json': { schema: op.body } } } }
      : {}),
    responses: {
      [String(op.status ?? 200)]: {
        description: 'OK',
        content: { 'application/json': { schema: op.response ?? any } },
      },
      ...(auth === 'none' ? {} : { 401: { $ref: '#/components/responses/Error' } }),
      ...(op.role ? { 403: { $ref: '#/components/responses/Error' } } : {}),
      default: { $ref: '#/components/responses/Error' },
    },
  };
}

let cached: Schema | undefined;

export function openApiDocument(): Schema {
  if (cached) return cached;
  const paths: Record<string, Record<string, Schema>> = {};
  for (const [method, path, op] of OPS) {
    paths[path] = { ...paths[path], [method]: operation(method, path, op) };
  }
  cached = {
    openapi: '3.1.0',
    info: {
      title: 'Zyrox API',
      version: '1',
      description:
        'Delivery API (`/v1`, public keys, used by apps) and admin API (`/api/v1`, personal access tokens or the dashboard session). Errors are `{ "error": { "message", "code", "details" } }`.',
    },
    servers: [{ url: '/' }],
    tags: [
      'Delivery',
      'Auth',
      'Projects',
      'Documents',
      'Releases',
      'Manifests',
      'Functions',
      'Webhooks',
      'Preview',
      'Export',
      'AI',
      'Server',
    ].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        publicKey: { type: 'http', scheme: 'bearer', description: "An environment's public key (pk_…)" },
        token: { type: 'http', scheme: 'bearer', description: 'Personal access token (zyx_…)' },
        session: { type: 'apiKey', in: 'cookie', name: 'zyrox_session' },
      },
      responses: {
        Error: { description: 'Error', content: { 'application/json': { schema: ref('Error') } } },
      },
      schemas: {
        Error: obj({ error: obj({ message: str(), code: str(), details: any }, ['message', 'code']) }, [
          'error',
        ]),
        User: obj({ id: str(), email: str(), name: str() }),
        Document: documentJsonSchema(),
        Bootstrap: obj({
          ttl: int('Seconds before refreshing'),
          docs: { type: 'object', additionalProperties: str(), description: 'Document key → ref' },
          strings: obj({
            defaultLocale: str(),
            refs: { type: 'object', additionalProperties: str() },
            translate: bool,
            suggested: str(),
          }),
          experiments: list(obj({ key: str(), variant: str(), docs: list(str()) })),
          preview: bool,
        }),
        Webhook: obj({
          id: str(),
          url: str(),
          description: str(),
          events: list(str()),
          enabled: bool,
          secret: str('Only when created or rotated'),
          createdAt: str(),
        }),
        WebhookPayload: obj({
          id: str('Same for retries'),
          event: str(),
          project: obj({ id: str(), slug: str() }),
          actor: obj({ id: str(), email: str() }),
          target: str(),
          details: { type: 'object' },
          createdAt: str(),
        }),
        ProjectExport: obj(
          {
            zyrox: { const: 'project' },
            version: { const: 1 },
            project: { type: 'object' },
            environments: list({ type: 'object' }),
            documents: list(
              obj({ key: str(), kind: str(), title: str(), draft: any, versions: list({ type: 'object' }) }),
            ),
            functions: list({ type: 'object' }),
            webhooks: list({ type: 'object' }),
            releases: list({ type: 'object' }),
          },
          ['zyrox', 'version'],
        ),
      },
    },
    webhooks: {
      projectEvent: {
        post: {
          summary:
            'A project event (signed: x-zyrox-signature = sha256=HMAC(secret, x-zyrox-timestamp + "." + body))',
          requestBody: { content: { 'application/json': { schema: ref('WebhookPayload') } } },
          responses: { 200: { description: 'Any 2xx acknowledges; others are retried' } },
        },
      },
    },
  };
  return cached;
}

/** `(method, path)` pairs described, with Hono-style params, for the completeness test. */
export function describedRoutes(): [string, string][] {
  return OPS.map(([method, path]) => [method.toUpperCase(), path]);
}
