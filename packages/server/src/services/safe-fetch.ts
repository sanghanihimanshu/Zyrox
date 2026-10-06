import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

/** Raised for URLs we refuse to call (private networks, wrong scheme). */
export class BlockedUrlError extends Error {}

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function ipv4Private(ip: string): boolean {
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast, reserved
  );
}

/** Loopback, private, link-local, CGNAT, multicast and reserved addresses, for IPv4 and IPv6. */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return ipv4Private(ip);
  if (version !== 6) return true;
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return ipv4Private(mapped[1]!);
  return (
    lower === '::' ||
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') || // unique local
    /^fe[89ab]/.test(lower) || // link-local
    lower.startsWith('ff') // multicast
  );
}

export interface SafeRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

/** Checks a URL before saving it (e.g. a webhook). Throws `BlockedUrlError`. */
export function assertCallableUrl(raw: string, allowPrivate: boolean): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:'))
    throw new BlockedUrlError('Use an https:// URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    !allowPrivate &&
    (isIP(host) ? isPrivateAddress(host) : host === 'localhost' || host.endsWith('.localhost'))
  )
    throw new BlockedUrlError('Private and local network addresses are not allowed');
  return url;
}

/**
 * An outbound HTTP request that can't be pointed at the server's own network (SSRF): the
 * address is checked after DNS resolution, on the connection actually used.
 */
export function safeRequest(
  raw: string,
  init: SafeRequest,
  allowPrivate: boolean,
): Promise<{ status: number; text: string }> {
  const url = assertCallableUrl(raw, allowPrivate);
  const lookup = (
    hostname: string,
    options: object,
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const list = addresses as LookupAddress[];
      const blocked = !allowPrivate && list.some((a) => isPrivateAddress(a.address));
      if (blocked) return callback(new BlockedUrlError(`${hostname} resolves to a private address`), []);
      if ((options as { all?: boolean }).all) return callback(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  };
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      url,
      { method: init.method, headers: init.headers, lookup: lookup as never, timeout: init.timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error('Response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}
