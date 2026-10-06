import { timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { ServerContext } from '../context';
import { hmac, randomToken } from '../crypto';
import { functions } from '../db/schema';
import { BlockedUrlError, safeRequest } from './safe-fetch';

export interface FunctionContext {
  project: { id: string; slug: string };
  environment: { id: string; key: string };
  /**
   * The app's user/install id, as the app reported it (used for rollouts). It is NOT
   * authenticated: verify `userToken` with your own auth to know who is calling.
   */
  user: string;
  /** The end user's token from your app (provider `userToken`), forwarded untouched. */
  userToken?: string;
  attrs: Record<string, string>;
  screen?: string;
  nodeId?: string;
}

/** A function that runs inside the Zyrox server process. */
export type CodeFunction = (args: Record<string, unknown>, ctx: FunctionContext) => unknown;

export class FunctionError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
  }
}

/** Signs a webhook body: `x-zyrox-signature: sha256=<hmac(secret, timestamp + "." + body)>`. */
export function signatureHeaders(secret: string, body: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    'x-zyrox-timestamp': timestamp,
    'x-zyrox-signature': `sha256=${hmac(secret, `${timestamp}.${body}`)}`,
  };
}

/**
 * Runs a remote function: code functions registered on the server first, then webhook functions
 * configured in the dashboard (signed with HMAC, SSRF-protected, subject to a timeout).
 */
export async function runFunction(
  ctx: ServerContext,
  name: string,
  args: Record<string, unknown>,
  fctx: FunctionContext,
): Promise<unknown> {
  const local = ctx.options.functions?.[name];
  if (local) return local(args, fctx);
  const [fn] = await ctx.db
    .select()
    .from(functions)
    .where(and(eq(functions.projectId, fctx.project.id), eq(functions.name, name)));
  if (!fn?.enabled) throw new FunctionError(`Unknown function "${name}"`, 404);
  const { userToken, ...context } = fctx;
  const body = JSON.stringify({ fn: name, args, context });
  let res: { status: number; text: string };
  try {
    res = await safeRequest(
      fn.url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-zyrox-function': name,
          ...(userToken ? { 'x-zyrox-user-token': userToken } : {}),
          ...signatureHeaders(ctx.secrets.open(fn.secret), body),
        },
        body,
        timeoutMs: fn.timeoutMs,
      },
      Boolean(ctx.options.allowPrivateUrls),
    );
  } catch (err) {
    if (err instanceof BlockedUrlError) throw new FunctionError(`Function "${name}": ${err.message}`, 502);
    if ((err as { code?: string }).code === 'ETIMEDOUT')
      throw new FunctionError(`Function "${name}" timed out`, 504);
    throw new FunctionError(`Function "${name}" is unreachable`, 502);
  }
  let parsed: unknown = res.text;
  try {
    parsed = res.text ? JSON.parse(res.text) : null;
  } catch {
    // plain text result
  }
  if (res.status < 200 || res.status >= 300) {
    const message = errorMessage(parsed) ?? `Function "${name}" failed with HTTP ${res.status}`;
    throw new FunctionError(message, res.status >= 500 ? 502 : res.status);
  }
  return parsed && typeof parsed === 'object' && 'result' in parsed
    ? (parsed as { result: unknown }).result
    : parsed;
}

function errorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || !('error' in body)) return undefined;
  const error = (body as { error: unknown }).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error)
    return String((error as { message: unknown }).message);
  return undefined;
}

/** Verifies a request your function receives. Use it in your Lambda / Cloud Run / Vercel handler. */
export function verifySignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
  maxAgeSeconds = 300,
): boolean {
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > maxAgeSeconds) return false;
  const expected = Buffer.from(`sha256=${hmac(secret, `${timestamp}.${body}`)}`);
  const actual = Buffer.from(String(signature));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const newFunctionSecret = () => `whsec_${randomToken(24)}`;
