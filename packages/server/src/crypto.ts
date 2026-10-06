import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Random id like `doc_8f3k2m9q4t7v1x5z`. */
export function newId(prefix: string, bytes = 10): string {
  const buf = randomBytes(bytes);
  let out = '';
  for (const b of buf) out += ALPHABET[b % 32];
  return `${prefix}_${out}`;
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Stable 0–9999 bucket for percentage rollouts and experiment assignment. */
export function bucket(...parts: string[]): number {
  return Number.parseInt(sha256(parts.join('\u0000')).slice(0, 8), 16) % 10000;
}

export function today(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}
