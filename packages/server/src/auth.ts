import { and, eq, gt, or } from 'drizzle-orm';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { AppEnv, ServerContext, TokenScope, UserRow } from './context';
import { sha256 } from './crypto';
import { apiTokens, members, projects, type Role, sessions, users } from './db/schema';
import { fail, forbidden, notFound } from './errors';

export const SESSION_COOKIE = 'zyrox_session';
export const SESSION_DAYS = 30;
const ROLE_ORDER: Role[] = ['viewer', 'editor', 'publisher', 'admin'];

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(min);
}

export interface Authenticated {
  user: UserRow;
  /** Set when a personal access token was used. */
  scope?: TokenScope;
}

/**
 * Resolves the caller from the session cookie (dashboard) or a `Bearer zyx_…` personal access
 * token (CLI, CI, agents). Session tokens are only accepted as cookies.
 */
export async function authenticate(
  ctx: ServerContext,
  cookie: string | undefined,
  authorization: string | undefined,
): Promise<Authenticated | undefined> {
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : undefined;
  if (bearer) {
    if (!bearer.startsWith('zyx_')) return undefined;
    const [row] = await ctx.db
      .select({ user: users, token: apiTokens })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.userId))
      .where(eq(apiTokens.tokenHash, sha256(bearer)));
    if (!row || (row.token.expiresAt && row.token.expiresAt < new Date())) return undefined;
    void ctx.db
      .update(apiTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiTokens.id, row.token.id))
      .catch(() => {});
    const restricted = row.token.projectId || row.token.role;
    return {
      user: row.user,
      ...(restricted ? { scope: { projectId: row.token.projectId, role: row.token.role } } : {}),
    };
  }
  if (!cookie) return undefined;
  const [row] = await ctx.db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sha256(cookie)), gt(sessions.expiresAt, new Date())));
  return row ? { user: row.user } : undefined;
}

export async function currentUser(
  ctx: ServerContext,
  cookie: string | undefined,
  authorization: string | undefined,
): Promise<UserRow | undefined> {
  return (await authenticate(ctx, cookie, authorization))?.user;
}

export function requireUser(ctx: ServerContext) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const auth = await authenticate(ctx, getCookie(c, SESSION_COOKIE), c.req.header('authorization'));
    if (!auth) fail(401, 'Sign in required', 'unauthorized');
    c.set('user', auth.user);
    c.set('scope', auth.scope);
    await next();
  });
}

/** Rejects restricted tokens (project- or role-scoped) on account-wide routes. */
export function requireUnrestricted() {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (c.get('scope')) forbidden('This token is limited to a project or role and can’t do this');
    await next();
  });
}

/** The role a caller has in a project, after applying the token's limits. */
export function effectiveRole(role: Role | undefined, scope: TokenScope | undefined, projectId: string) {
  if (!role) return undefined;
  if (scope?.projectId && scope.projectId !== projectId) return undefined;
  if (scope?.role && !roleAtLeast(scope.role, role)) return scope.role;
  return role;
}

/** Loads `:project` (slug or id) and checks the user's role in it. */
export function requireProject(ctx: ServerContext, min: Role = 'viewer') {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get('user');
    const ref = c.req.param('project');
    if (!ref) notFound('Project');
    const [project] = await ctx.db
      .select()
      .from(projects)
      .where(or(eq(projects.slug, ref), eq(projects.id, ref)));
    if (!project) notFound('Project');
    let role: Role | undefined = user.owner ? 'admin' : undefined;
    if (!role) {
      const [member] = await ctx.db
        .select()
        .from(members)
        .where(and(eq(members.projectId, project.id), eq(members.userId, user.id)));
      role = member?.role;
    }
    role = effectiveRole(role, c.get('scope'), project.id);
    if (!role) notFound('Project');
    if (!roleAtLeast(role, min)) forbidden(`This needs the ${min} role`);
    c.set('project', project);
    c.set('role', role);
    await next();
  });
}

export function requireRole(min: Role) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!roleAtLeast(c.get('role'), min)) forbidden(`This needs the ${min} role`);
    await next();
  });
}
