import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createZyroxServer, type ZyroxServer } from '../src';
import { apiTokens, functions } from '../src/db/schema';
import { isPrivateAddress } from '../src/services/safe-fetch';

let server: ZyroxServer;
let cookie = '';
let pk = '';

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await server.app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}
const asOwner = (method: string, path: string, body?: unknown) => call(method, path, body, { cookie });

beforeAll(async () => {
  server = await createZyroxServer({
    database: 'memory://',
    counterIntervalMs: 0,
    ai: false,
    secretKey: 'k',
    rateLimits: { auth: 15 },
    corsOrigins: ['https://admin.example.com'],
    functions: { whoami: (_args, ctx) => ({ user: ctx.user, token: ctx.userToken ?? null }) },
  });
  const signup = await call('POST', '/api/auth/signup', {
    email: 'ada@example.com',
    password: 'correct horse',
  });
  cookie = signup.headers.get('set-cookie')!.split(';')[0]!;
  const a = await asOwner('POST', '/api/projects', { name: 'A', slug: 'alpha' });
  await asOwner('POST', '/api/projects', { name: 'B', slug: 'beta' });
  pk = a.body.environments[0].publicKey;
});

afterAll(() => server?.close());

describe('sessions', () => {
  it('keeps the session token in the HTTP-only cookie only', async () => {
    const login = await call('POST', '/api/auth/login', {
      email: 'ada@example.com',
      password: 'correct horse',
    });
    expect(login.body).toEqual({ user: expect.objectContaining({ email: 'ada@example.com' }) });
    expect(login.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(login.headers.get('set-cookie')).toMatch(/SameSite=Lax/i);
    // A session token is not accepted as a bearer token.
    const raw = cookie.split('=')[1]!;
    expect((await call('GET', '/api/me', undefined, { authorization: `Bearer ${raw}` })).status).toBe(401);
    expect((await asOwner('GET', '/api/me')).status).toBe(200);
  });

  it('locks an account after repeated wrong passwords', async () => {
    await asOwner('POST', '/api/users', { email: 'eve@example.com', password: 'password123' });
    for (let i = 0; i < 10; i++)
      expect(
        (await call('POST', '/api/auth/login', { email: 'eve@example.com', password: 'wrong-guess' })).status,
      ).toBe(401);
    const locked = await call('POST', '/api/auth/login', {
      email: 'eve@example.com',
      password: 'password123',
    });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('locked');
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('rate-limits sign-in attempts per client', async () => {
    let limited: Awaited<ReturnType<typeof call>> | undefined;
    for (let i = 0; i < 20 && !limited; i++) {
      const res = await call('POST', '/api/auth/login', {
        email: `nobody${i}@example.com`,
        password: 'whatever1',
      });
      if (res.status === 429) limited = res;
    }
    expect(limited?.body.error.code).toBe('rate_limited');
    expect(limited?.headers.get('retry-after')).toBeTruthy();
  });
});

describe('request limits and headers', () => {
  it('rejects oversized bodies before parsing them', async () => {
    const huge = JSON.stringify({ events: [{ type: 'screen_view', message: 'x'.repeat(300 * 1024) }] });
    const res = await call('POST', '/v1/telemetry', huge, {
      authorization: `Bearer ${pk}`,
      'content-length': String(huge.length),
    });
    expect(res.status).toBe(413);
  });

  it('sends security headers on the dashboard and admin API, not on public delivery', async () => {
    const api = await asOwner('GET', '/api/me');
    expect(api.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    expect(api.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(api.headers.get('x-content-type-options')).toBe('nosniff');
    const boot = await call('GET', '/v1/bootstrap', undefined, { authorization: `Bearer ${pk}` });
    expect(boot.headers.get('x-content-type-options')).toBe('nosniff');
    expect(boot.headers.get('x-frame-options')).toBeNull();
    expect(boot.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('serves the admin API under /api/v1 and allows configured origins with tokens', async () => {
    expect((await asOwner('GET', '/api/v1/projects/alpha')).status).toBe(200);
    const preflight = await server.app.request('/api/v1/me', {
      method: 'OPTIONS',
      headers: { origin: 'https://admin.example.com', 'access-control-request-method': 'GET' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://admin.example.com');
    const other = await server.app.request('/api/v1/me', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(other.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
  });
});

describe('scoped personal access tokens', () => {
  it('limits a token to one project, a maximum role and an expiry', async () => {
    const created = await asOwner('POST', '/api/tokens', {
      name: 'ci',
      project: 'alpha',
      role: 'viewer',
      expiresInDays: 30,
    });
    expect(created.body).toMatchObject({ project: 'alpha', role: 'viewer' });
    const auth = { authorization: `Bearer ${created.body.token}` };
    expect((await call('GET', '/api/projects/alpha', undefined, auth)).body.role).toBe('viewer');
    expect((await call('GET', '/api/projects/beta', undefined, auth)).status).toBe(404);
    const me = await call('GET', '/api/me', undefined, auth);
    expect(me.body.projects.map((p: { slug: string }) => p.slug)).toEqual(['alpha']);
    expect(me.body.scope).toMatchObject({ role: 'viewer' });
    expect(
      (await call('POST', '/api/projects/alpha/documents', { key: 'x', kind: 'screen' }, auth)).status,
    ).toBe(403);
    // Restricted tokens can't mint tokens, create projects or users.
    expect((await call('POST', '/api/tokens', { name: 'more' }, auth)).status).toBe(403);
    expect((await call('POST', '/api/projects', { name: 'C', slug: 'gamma' }, auth)).status).toBe(403);
    const list = await asOwner('GET', '/api/tokens');
    expect(list.body.tokens.find((t: { name: string }) => t.name === 'ci')).toMatchObject({
      project: 'alpha',
      role: 'viewer',
    });

    await server.database.db
      .update(apiTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiTokens.id, created.body.id));
    expect((await call('GET', '/api/me', undefined, auth)).status).toBe(401);
  });
});

describe('remote functions', () => {
  it('refuses private, local and plain-http webhook URLs', async () => {
    for (const url of [
      'http://example.com/fn',
      'https://127.0.0.1/fn',
      'https://10.1.2.3/fn',
      'https://localhost/fn',
      'https://[::1]/fn',
    ]) {
      const res = await asOwner('POST', '/api/projects/alpha/functions', { name: 'f', url });
      expect(res.status, url).toBe(400);
    }
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
    expect(isPrivateAddress('::ffff:192.168.1.1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });

  it('encrypts webhook secrets at rest and blocks private targets at call time', async () => {
    const created = await asOwner('POST', '/api/projects/alpha/functions', {
      name: 'quote',
      url: 'https://hooks.example.com/quote',
    });
    expect(created.status).toBe(201);
    expect(created.body.function.secret).toMatch(/^whsec_/);
    const [row] = await server.database.db.select().from(functions).where(eq(functions.name, 'quote'));
    expect(row!.secret).toMatch(/^enc:v1:/);
    expect(server.ctx.secrets.open(row!.secret)).toBe(created.body.function.secret);
    // A URL that bypassed validation (e.g. older data) still can't reach the private network.
    await server.database.db
      .update(functions)
      .set({ url: 'https://localhost/quote' })
      .where(eq(functions.name, 'quote'));
    const res = await call('POST', '/v1/functions/quote', { args: {} }, { authorization: `Bearer ${pk}` });
    expect(res.status).toBe(502);
    expect(res.body.error.message).toMatch(/not allowed|private/);
  });

  it('forwards the app user token so functions can authenticate the caller', async () => {
    const res = await call(
      'POST',
      '/v1/functions/whoami',
      { args: {} },
      {
        authorization: `Bearer ${pk}`,
        'x-zyrox-user': 'u-1',
        'x-zyrox-user-token': 'eyJhbGciOi.jwt',
      },
    );
    expect(res.body.result).toEqual({ user: 'u-1', token: 'eyJhbGciOi.jwt' });
  });
});
