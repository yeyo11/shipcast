import { desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/connect.ts';
import { apiTokens } from '../db/schema.ts';

/** `read` sees launches, posts, numbers, accounts and jobs; `write` starts and approves work. See docs/decisions/api-tokens.md */
export type ApiScope = 'read' | 'write';
export const API_SCOPES: readonly ApiScope[] = ['read', 'write'];

/** A REST API token as the app lists it: never its hash */
export interface ApiToken {
  id: number;
  name: string;
  scopes: ApiScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

function toApiToken(row: typeof apiTokens.$inferSelect): ApiToken {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes.filter((s): s is ApiScope => (API_SCOPES as readonly string[]).includes(s)),
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

/** The REST API's tokens, kept as hashes; see docs/decisions/api-tokens.md */
export class ApiTokenRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** A token for the REST API, by its hash; the token itself is shown once and never stored */
  async addApiToken(token: { name: string; hash: string; scopes: ApiScope[] }): Promise<ApiToken> {
    const [row] = await this.#db.insert(apiTokens).values(token).returning();
    return toApiToken(row!);
  }

  /** One token with its hash, which only the code that verifies a token should read */
  async apiToken(id: number): Promise<(ApiToken & { hash: string }) | undefined> {
    const [row] = await this.#db.select().from(apiTokens).where(eq(apiTokens.id, id));
    return row ? { ...toApiToken(row), hash: row.hash } : undefined;
  }

  /** Every token, revoked ones too, the newest first; never their hashes */
  async apiTokens(): Promise<ApiToken[]> {
    const rows = await this.#db.select().from(apiTokens).orderBy(desc(apiTokens.id));
    return rows.map(toApiToken);
  }

  async touchApiToken(id: number, at = new Date()): Promise<void> {
    await this.#db.update(apiTokens).set({ lastUsedAt: at.toISOString() }).where(eq(apiTokens.id, id));
  }

  /** Revoking is for good; a token revoked already keeps its first revocation time */
  async revokeApiToken(id: number, at = new Date()): Promise<ApiToken | undefined> {
    const [row] = await this.#db
      .update(apiTokens)
      .set({ revokedAt: sql`coalesce(${apiTokens.revokedAt}, ${at.toISOString()})` })
      .where(eq(apiTokens.id, id))
      .returning();
    return row ? toApiToken(row) : undefined;
  }
}
