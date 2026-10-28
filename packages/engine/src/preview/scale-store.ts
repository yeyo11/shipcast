import { sql } from 'drizzle-orm';
import type { Database } from '../db/connect.ts';
import { RawQueries } from '../repositories/sql.ts';

/** A post row as the scale test's check reads it */
export interface ScalePieceRow {
  launchId: number;
  channel: string;
  kind: string;
  status: string;
  externalId: string | null;
  scheduledAt: string | null;
  publishedAt: string;
}

/**
 * The reads the scale test (scripts/scale-test.ts, on a preview) makes of the registry that no
 * repository has: which database it is connected to, and every post that went out on a fake network
 * or belongs to the run's launches.
 */
export class PreviewScaleStore {
  readonly #raw: RawQueries;

  constructor(db: Database) {
    this.#raw = new RawQueries(db);
  }

  /** The database's own name, as Postgres says it, for the driver's hard check */
  async currentDatabase(): Promise<string | undefined> {
    return (await this.#raw.selectRows<{ name: string }>(sql`SELECT current_database() AS name`))[0]?.name;
  }

  /** Every post with a fake network's id, and every post of the given launches */
  async pieces(launchIds: readonly number[]): Promise<ScalePieceRow[]> {
    const ids = launchIds.length > 0 ? sql.join(launchIds.map((id) => sql`${id}`), sql`, `) : sql`-1`;
    const rows = await this.#raw.selectRows<{ launch_id: number | string; channel: string; kind: string; status: string; external_id: string | null; scheduled_at: string | null; published_at: string }>(
      sql`SELECT launch_id, channel, kind, status, external_id, scheduled_at, published_at FROM posts WHERE external_id LIKE 'preview-%' OR launch_id IN (${ids})`,
    );
    return rows.map((r) => ({ launchId: Number(r.launch_id), channel: r.channel, kind: r.kind, status: r.status, externalId: r.external_id, scheduledAt: r.scheduled_at, publishedAt: r.published_at }));
  }
}
