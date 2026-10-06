import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export function fail(
  status: ContentfulStatusCode,
  message: string,
  code = 'error',
  details?: unknown,
): never {
  throw new HTTPException(status, { message, cause: { code, details } });
}

export function notFound(what: string): never {
  fail(404, `${what} not found`, 'not_found');
}

export function forbidden(message = 'You do not have access to this'): never {
  fail(403, message, 'forbidden');
}
