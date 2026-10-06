import { z } from '@zyrox/protocol';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { requireProject, requireRole, requireUnrestricted, requireUser } from '../auth';
import type { AppEnv, ServerContext } from '../context';
import { newId, randomToken } from '../crypto';
import type { Db } from '../db';
import { environments, members, projects, type Role, users } from '../db/schema';
import { fail, notFound } from '../errors';
import { audit } from '../services/audit';

const ENVIRONMENTS = [
  { key: 'dev', name: 'Development' },
  { key: 'staging', name: 'Staging' },
  { key: 'prod', name: 'Production' },
] as const;

const roleSchema = z.enum(['viewer', 'editor', 'publisher', 'admin']);
const newPublicKey = (env: string) => `pk_${env}_${randomToken(18)}`;

export async function createProject(
  db: Db,
  input: { name: string; slug: string; defaultLocale?: string },
  ownerId: string,
) {
  const [taken] = await db.select().from(projects).where(eq(projects.slug, input.slug));
  if (taken) fail(409, `The slug "${input.slug}" is taken`, 'conflict');
  const [project] = await db
    .insert(projects)
    .values({
      id: newId('prj'),
      slug: input.slug,
      name: input.name,
      defaultLocale: input.defaultLocale ?? 'en',
    })
    .returning();
  await db.insert(members).values({ projectId: project!.id, userId: ownerId, role: 'admin' });
  const envs = await db
    .insert(environments)
    .values(
      ENVIRONMENTS.map((e) => ({
        id: newId('env'),
        projectId: project!.id,
        key: e.key,
        name: e.name,
        publicKey: newPublicKey(e.key),
      })),
    )
    .returning();
  return { project: project!, environments: envs };
}

export function projectRoutes(ctx: ServerContext) {
  const app = new Hono<AppEnv>();
  app.use('*', requireUser(ctx));

  app.post('/projects', requireUnrestricted(), async (c) => {
    const input = z
      .object({
        name: z.string().min(1).max(100),
        slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}$/, 'Use 2–49 lowercase letters, digits and dashes'),
        defaultLocale: z.string().min(2).max(20).optional(),
      })
      .parse(await c.req.json());
    const result = await createProject(ctx.db, input, c.get('user').id);
    await audit(ctx.db, result.project.id, c.get('user').id, 'project.create', result.project.slug);
    return c.json(result, 201);
  });

  app.use('/projects/:project', requireProject(ctx));
  app.use('/projects/:project/*', requireProject(ctx));

  app.get('/projects/:project', async (c) => {
    const project = c.get('project');
    const envs = await ctx.db.select().from(environments).where(eq(environments.projectId, project.id));
    const order = ENVIRONMENTS.map((e) => e.key as string);
    envs.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    return c.json({ project, role: c.get('role'), environments: envs });
  });

  app.patch('/projects/:project', requireRole('admin'), async (c) => {
    const input = z
      .object({
        name: z.string().min(1).max(100).optional(),
        defaultLocale: z.string().min(2).max(20).optional(),
        previewUrl: z.url().nullable().optional(),
      })
      .parse(await c.req.json());
    const [project] = await ctx.db
      .update(projects)
      .set(input)
      .where(eq(projects.id, c.get('project').id))
      .returning();
    ctx.delivery.invalidate();
    await audit(ctx.db, project!.id, c.get('user').id, 'project.update', project!.slug, input);
    return c.json({ project });
  });

  app.delete('/projects/:project', requireRole('admin'), async (c) => {
    const project = c.get('project');
    await audit(ctx.db, project.id, c.get('user').id, 'project.delete', project.slug);
    await ctx.db.delete(projects).where(eq(projects.id, project.id));
    ctx.delivery.invalidate();
    return c.json({ ok: true });
  });

  app.patch('/projects/:project/environments/:env', requireRole('admin'), async (c) => {
    const input = z
      .object({
        name: z.string().min(1).max(50).optional(),
        ttl: z.number().int().min(5).max(86400).optional(),
        rotateKey: z.boolean().optional(),
      })
      .parse(await c.req.json());
    const { rotateKey, ...rest } = input;
    const set: Partial<typeof environments.$inferInsert> = { ...rest };
    if (rotateKey) set.publicKey = newPublicKey(c.req.param('env'));
    const [env] = await ctx.db
      .update(environments)
      .set(set)
      .where(and(eq(environments.projectId, c.get('project').id), eq(environments.key, c.req.param('env'))))
      .returning();
    if (!env) notFound('Environment');
    ctx.delivery.invalidate();
    await audit(ctx.db, c.get('project').id, c.get('user').id, 'environment.update', env.key, {
      ...rest,
      rotateKey,
    });
    return c.json({ environment: env });
  });

  app.get('/projects/:project/members', async (c) => {
    const rows = await ctx.db
      .select({ id: users.id, email: users.email, name: users.name, role: members.role })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(eq(members.projectId, c.get('project').id));
    return c.json({ members: rows });
  });

  app.put('/projects/:project/members', requireRole('admin'), async (c) => {
    const { email, role } = z.object({ email: z.email(), role: roleSchema }).parse(await c.req.json());
    const [user] = await ctx.db.select().from(users).where(eq(users.email, email.toLowerCase()));
    if (!user) notFound('User');
    await ctx.db
      .insert(members)
      .values({ projectId: c.get('project').id, userId: user.id, role: role as Role })
      .onConflictDoUpdate({ target: [members.projectId, members.userId], set: { role: role as Role } });
    await audit(ctx.db, c.get('project').id, c.get('user').id, 'member.set', email, { role });
    return c.json({ ok: true });
  });

  app.delete('/projects/:project/members/:userId', requireRole('admin'), async (c) => {
    await ctx.db
      .delete(members)
      .where(and(eq(members.projectId, c.get('project').id), eq(members.userId, c.req.param('userId'))));
    await audit(ctx.db, c.get('project').id, c.get('user').id, 'member.remove', c.req.param('userId'));
    return c.json({ ok: true });
  });

  return app;
}
