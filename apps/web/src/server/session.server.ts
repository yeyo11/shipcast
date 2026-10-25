import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SecretStore } from '@shipcast/runtime';

export const SESSION_COOKIE = 'sc_session';
export const STATE_COOKIE = 'sc_oauth_state';
const SESSION_DAYS = 14;

/** The key sessions are signed with, made once and kept in the keychain */
async function sessionKey(secrets: SecretStore): Promise<Buffer> {
  let key = await secrets.get('app:session-key');
  if (!key) {
    key = randomBytes(32).toString('base64url');
    await secrets.set('app:session-key', key, 'web app session key');
  }
  return Buffer.from(key, 'base64url');
}

export interface Session {
  login: string;
  expires: number;
  /** The GitHub profile's name and picture, read at sign-in; a console link's session has neither */
  name?: string;
  avatarUrl?: string;
}

/** What GitHub said about the user at sign-in, beside the login */
export interface Profile {
  name?: string;
  avatarUrl?: string;
}

const sign = (key: Buffer, payload: string) => createHmac('sha256', key).update(payload).digest('base64url');

/**
 * A session is the GitHub login and an expiry, signed: no session table to keep, and nothing in
 * the cookie a person could change without breaking the signature.
 */
export async function createSession(secrets: SecretStore, login: string, now = Date.now(), profile: Profile = {}): Promise<{ value: string; maxAge: number }> {
  const session: Session = { login, expires: now + SESSION_DAYS * 86_400_000, ...profile };
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return { value: `${payload}.${sign(await sessionKey(secrets), payload)}`, maxAge: SESSION_DAYS * 86_400 };
}

export async function readSession(secrets: SecretStore, cookie: string | undefined, now = Date.now()): Promise<Session | undefined> {
  if (!cookie) return undefined;
  const [payload, signature] = cookie.split('.');
  if (!payload || !signature) return undefined;
  const expected = Buffer.from(sign(await sessionKey(secrets), payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Session;
    return session.expires > now ? session : undefined;
  } catch {
    return undefined;
  }
}

/** Reads one cookie from a request's Cookie header */
export function cookieOf(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/** HttpOnly, Secure and SameSite=Lax: Lax lets GitHub's redirect back carry the state cookie */
export function setCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
