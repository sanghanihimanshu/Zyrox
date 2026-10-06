import { z } from '@wishyor/zyrox-protocol';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  currentUser,
  effectiveRole,
  requireUnrestricted,
  requireUser,
  SESSION_COOKIE,
  SESSION_DAYS,
} from '../auth';
import type { AppEnv, ServerContext, UserRow } from '../context';
import { hashPassword, newId, randomToken, sha256, verifyPassword } from '../crypto';
import { apiTokens, members, projects, sessions, users } from '../db/schema';
import { fail, forbidden, notFound } from '../errors';

const credentials = z.object({
  email: z.email().max(200),
  password: z.string().min(8, 'Use at least 8 characters').max(200),
  name: z.string().min(1).max(100).optional(),
});

export function publicUser(user: UserRow) {
  return { id: user.id, email: user.email, name: user.name, owner: user.owner };
}

export async function createUser(
  ctx: ServerContext,
  input: { email: string; password: string; name?: string; owner?: boolean },
) {
  const [existing] = await ctx.db.select().from(users).where(eq(users.email, input.email.toLowerCase()));
  if (existing) fail(409, 'That email is already registered', 'conflict');
  const [user] = await ctx.db
    .insert(users)
    .values({
      id: newId('usr'),
      email: input.email.toLowerCase(),
      name: input.name ?? input.email.split('@')[0]!,
      passwordHash: await hashPassword(input.password),
      owner: input.owner ?? false,
    })
    .returning();
  return user!;
}

export async function createSession(ctx: ServerContext, userId: string): Promise<string> {
  const token = randomToken(32);
  await ctx.db.insert(sessions).values({
    id: sha256(token),
    userId,
    expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000),
  });
  return token;
}

export function authRoutes(ctx: ServerContext) {
  const app = new Hono<AppEnv>();

  const startSession = async (c: import('hono').Context, user: UserRow) => {
    const token = await createSession(ctx, user.id);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: Boolean(ctx.options.secureCookies),
      path: '/',
      maxAge: SESSION_DAYS * 86_400,
    });
    // The session token only travels in the HTTP-only cookie, never in a response body.
    return c.json({ user: publicUser(user) });
  };
  // Lockout after repeated wrong passwords for one account (on top of per-IP rate limits).
  const failures = new Map<string, { count: number; first: number }>();
  const LOCK_AFTER = 10;
  const LOCK_MS = 15 * 60_000;

  app.get('/auth/status', async (c) => {
    const [{ count }] = (await ctx.db.select({ count: sql<number>`count(*)::int` }).from(users)) as [
      { count: number },
    ];
    const user = await currentUser(ctx, getCookie(c, SESSION_COOKIE), c.req.header('authorization'));
    return c.json({
      hasUsers: count > 0,
      openSignup: Boolean(ctx.options.openSignup) || count === 0,
      user: user ? publicUser(user) : null,
    });
  });

  app.post('/auth/signup', async (c) => {
    const input = credentials.parse(await c.req.json());
    const [{ count }] = (await ctx.db.select({ count: sql<number>`count(*)::int` }).from(users)) as [
      { count: number },
    ];
    if (count > 0 && !ctx.options.openSignup) forbidden('Sign-up is closed. Ask an admin to invite you.');
    const user = await createUser(ctx, { ...input, owner: count === 0 });
    return startSession(c, user);
  });

  app.post('/auth/login', async (c) => {
    const input = credentials.pick({ email: true, password: true }).parse(await c.req.json());
    const email = input.email.toLowerCase();
    const now = Date.now();
    const record = failures.get(email);
    if (record && now - record.first > LOCK_MS) failures.delete(email);
    else if (record && record.count >= LOCK_AFTER) {
      c.header('retry-after', String(Math.ceil((record.first + LOCK_MS - now) / 1000)));
      fail(429, 'Too many failed sign-in attempts. Try again in 15 minutes.', 'locked');
    }
    const [user] = await ctx.db.select().from(users).where(eq(users.email, email));
    if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
      const current = failures.get(email) ?? { count: 0, first: now };
      current.count++;
      failures.set(email, current);
      fail(401, 'Wrong email or password', 'unauthorized');
    }
    failures.delete(email);
    return startSession(c, user);
  });

  app.post('/auth/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await ctx.db.delete(sessions).where(eq(sessions.id, sha256(token)));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.use('/me', requireUser(ctx));
  app.get('/me', async (c) => {
    const user = c.get('user');
    const rows = user.owner
      ? (await ctx.db.select().from(projects)).map((p) => ({ ...p, role: 'admin' as const }))
      : (
          await ctx.db
            .select({ project: projects, role: members.role })
            .from(members)
            .innerJoin(projects, eq(projects.id, members.projectId))
            .where(eq(members.userId, user.id))
        ).map((r) => ({ ...r.project, role: r.role }));
    const scope = c.get('scope');
    const visible = rows.flatMap((p) => {
      const role = effectiveRole(p.role, scope, p.id);
      return role ? [{ ...p, role }] : [];
    });
    return c.json({ user: publicUser(user), projects: visible, ...(scope ? { scope } : {}) });
  });

  app.patch('/me', requireUnrestricted(), async (c) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(100) }).parse(await c.req.json());
    const [user] = await ctx.db
      .update(users)
      .set({ name })
      .where(eq(users.id, c.get('user').id))
      .returning();
    return c.json({ user: publicUser(user!) });
  });

  app.use('/tokens/*', requireUser(ctx), requireUnrestricted());
  app.use('/tokens', requireUser(ctx), requireUnrestricted());
  const tokenView = {
    id: apiTokens.id,
    name: apiTokens.name,
    project: projects.slug,
    role: apiTokens.role,
    expiresAt: apiTokens.expiresAt,
    createdAt: apiTokens.createdAt,
    lastUsedAt: apiTokens.lastUsedAt,
  };
  app.get('/tokens', async (c) => {
    const rows = await ctx.db
      .select(tokenView)
      .from(apiTokens)
      .leftJoin(projects, eq(projects.id, apiTokens.projectId))
      .where(eq(apiTokens.userId, c.get('user').id));
    return c.json({ tokens: rows });
  });
  app.post('/tokens', async (c) => {
    const input = z
      .object({
        name: z.string().min(1).max(100),
        /** Limit to one project (slug). */
        project: z.string().optional(),
        /** Limit to at most this role. */
        role: z.enum(['viewer', 'editor', 'publisher', 'admin']).optional(),
        expiresInDays: z.number().int().min(1).max(3650).optional(),
      })
      .parse(await c.req.json());
    const user = c.get('user');
    let projectId: string | null = null;
    if (input.project) {
      const [project] = await ctx.db.select().from(projects).where(eq(projects.slug, input.project));
      const [member] = project
        ? await ctx.db
            .select()
            .from(members)
            .where(and(eq(members.projectId, project.id), eq(members.userId, user.id)))
        : [];
      if (!project || (!member && !user.owner)) notFound('Project');
      projectId = project.id;
    }
    const token = `zyx_${randomToken(32)}`;
    const [row] = await ctx.db
      .insert(apiTokens)
      .values({
        id: newId('tok'),
        userId: user.id,
        name: input.name,
        tokenHash: sha256(token),
        projectId,
        role: input.role ?? null,
        expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
      })
      .returning({
        id: apiTokens.id,
        name: apiTokens.name,
        createdAt: apiTokens.createdAt,
        expiresAt: apiTokens.expiresAt,
      });
    return c.json({ token, ...row, project: input.project ?? null, role: input.role ?? null }, 201);
  });
  app.delete('/tokens/:id', async (c) => {
    await ctx.db
      .delete(apiTokens)
      .where(and(eq(apiTokens.id, c.req.param('id')), eq(apiTokens.userId, c.get('user').id)));
    return c.json({ ok: true });
  });

  app.use('/users', requireUser(ctx), requireUnrestricted());
  app.post('/users', async (c) => {
    if (!c.get('user').owner) forbidden('Only the owner can create users');
    const input = credentials.parse(await c.req.json());
    const user = await createUser(ctx, input);
    return c.json({ user: publicUser(user) }, 201);
  });

  return app;
}
