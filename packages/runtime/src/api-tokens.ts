import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appKey } from './app-keys.ts';
import { API_SCOPES, type ApiScope, type ApiToken, type Repositories } from '@shipcast/engine';
import { InvalidRequest } from '@shipcast/schema';
import type { SecretStore } from './secrets.ts';

/*
 * Tokens for the REST API. A token reads `shipcast_<id>_<secret>`: the id finds its row without a
 * lookup by secret, and the prefix lets secret scanners (GitHub's among them) recognise a leaked one.
 * The registry keeps an HMAC-SHA256 of the secret keyed with a pepper from the keychain, so a copy of
 * the database alone, a backup or a dump, holds nothing that signs in. A plain hash would do for 32
 * random bytes; the pepper costs nothing and keeps the database and the keychain both needed.
 * See docs/decisions/api-tokens.md
 */

export const API_TOKEN_PEPPER_KEY = 'app:api-token-pepper';
const TOKEN = /^shipcast_(\d{1,10})_([A-Za-z0-9_-]{43})$/;

export interface ApiTokenDeps {
  registry: Pick<Repositories, 'apiTokens'>;
  secrets: SecretStore;
}

async function pepper(secrets: SecretStore): Promise<Buffer> {
  return Buffer.from(await appKey(secrets, API_TOKEN_PEPPER_KEY, 'API token pepper'), 'base64url');
}

const digest = (key: Buffer, secret: string) => createHmac('sha256', key).update(secret).digest('hex');

export class InvalidScopes extends InvalidRequest {}

/** The scopes a person or a client asked for, checked: at least one, each known, no repeats */
export function parseScopes(value: unknown): ApiScope[] {
  const list = typeof value === 'string' ? value.split(',').map((s) => s.trim()) : value;
  if (!Array.isArray(list) || list.length === 0) throw new InvalidScopes(`a token needs scopes: ${API_SCOPES.join(', ')}`);
  const scopes = new Set<ApiScope>();
  for (const s of list) {
    if (typeof s !== 'string' || !(API_SCOPES as readonly string[]).includes(s)) throw new InvalidScopes(`unknown scope ${JSON.stringify(s)}; scopes are ${API_SCOPES.join(', ')}`);
    scopes.add(s as ApiScope);
  }
  return API_SCOPES.filter((s) => scopes.has(s));
}

/** `write` does not include `read`: a client that only starts launches never needs to list them */
export const hasScope = (token: Pick<ApiToken, 'scopes'>, scope: ApiScope) => token.scopes.includes(scope);

/** A new token; the returned `token` is the only time its secret exists outside the client */
export async function createApiToken(deps: ApiTokenDeps, name: string, scopes: ApiScope[]): Promise<{ token: string; record: ApiToken }> {
  const label = name.trim();
  if (!label || label.length > 100) throw new Error('a token needs a name of up to 100 characters');
  if (scopes.length === 0) throw new InvalidScopes('a token needs at least one scope');
  const secret = randomBytes(32).toString('base64url');
  const record = await deps.registry.apiTokens.addApiToken({ name: label, hash: digest(await pepper(deps.secrets), secret), scopes });
  return { token: `shipcast_${record.id}_${secret}`, record };
}

export type TokenCheck = { ok: true; token: ApiToken } | { ok: false; reason: 'malformed' | 'unknown' | 'revoked' };

// Compared against when no row matches, so an unknown id costs the same HMAC and comparison as a known one
const NO_HASH = '0'.repeat(64);

/** Checks a token as a client sent it; a good one has its last use recorded, at most once a minute */
export async function verifyApiToken(deps: ApiTokenDeps, presented: string, now = new Date()): Promise<TokenCheck> {
  const match = TOKEN.exec(presented);
  if (!match) return { ok: false, reason: 'malformed' };
  const row = await deps.registry.apiTokens.apiToken(Number(match[1]));
  const expected = Buffer.from(row?.hash ?? NO_HASH, 'hex');
  const given = Buffer.from(digest(await pepper(deps.secrets), match[2]!), 'hex');
  const same = expected.length === given.length && timingSafeEqual(expected, given);
  if (!row || !same) return { ok: false, reason: 'unknown' };
  if (row.revokedAt) return { ok: false, reason: 'revoked' };
  const { hash: _hash, ...token } = row;
  if (!token.lastUsedAt || now.getTime() - Date.parse(token.lastUsedAt) > 60_000) {
    await deps.registry.apiTokens.touchApiToken(token.id, now);
    token.lastUsedAt = now.toISOString();
  }
  return { ok: true, token };
}
