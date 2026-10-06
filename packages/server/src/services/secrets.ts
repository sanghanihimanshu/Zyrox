import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Encrypts secrets stored in the database (webhook signing secrets) with AES-256-GCM when the
 * server has `secretKey` (ZYROX_SECRET_KEY). Without a key, values are stored as they are.
 */
export class SecretBox {
  private readonly key: Buffer | undefined;

  constructor(secretKey: string | undefined) {
    this.key = secretKey ? createHash('sha256').update(secretKey).digest() : undefined;
  }

  get enabled(): boolean {
    return Boolean(this.key);
  }

  seal(plain: string): string {
    if (!this.key) return plain;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `enc:v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
  }

  open(stored: string): string {
    if (!stored.startsWith('enc:v1:')) return stored;
    if (!this.key)
      throw new Error('This secret is encrypted: set ZYROX_SECRET_KEY to the key it was stored with');
    const [, , iv, tag, data] = stored.split(':');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv!, 'base64'));
    decipher.setAuthTag(Buffer.from(tag!, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data!, 'base64')), decipher.final()]).toString('utf8');
  }
}
