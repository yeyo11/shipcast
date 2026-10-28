import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** A value sealed with AES-256-GCM: its nonce, its tag and its ciphertext, each in base64 */
export interface Sealed {
  iv: string;
  tag: string;
  data: string;
}

/** Seals bytes under a 32-byte key, with a fresh 12-byte nonce every time */
export function seal(key: Buffer, plain: Buffer | string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

/** Opens what `seal` sealed; throws when the key is not the one it was sealed with, or the bytes were changed */
export function unseal(key: Buffer, sealed: Sealed): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]);
}
