import { asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/connect.ts';
import { pushSubscriptions } from '../db/schema.ts';

/** A browser that takes Shipcast's web push notifications (docs/push.md) */
export interface PushSubscriptionRow {
  id: number;
  login: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  /** Event kind to whether this device is told of it; a kind left out is on */
  events: Record<string, boolean>;
  createdAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailure: string | null;
}

export interface NewPushSubscription {
  login: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  events?: Record<string, boolean>;
}

/** The push subscriptions, one per browser that turned notifications on */
export class PushSubscriptionRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Keeps a browser's subscription. The same endpoint again (the browser subscribed anew, or its keys
   * rotated) updates its row instead of adding one, and keeps the events the owner chose unless new
   * ones are given.
   */
  async subscribe(input: NewPushSubscription): Promise<PushSubscriptionRow> {
    const [row] = await this.#db
      .insert(pushSubscriptions)
      .values({ login: input.login, endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth, label: input.label, events: input.events ?? {} })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          login: input.login,
          p256dh: input.p256dh,
          auth: input.auth,
          label: input.label,
          ...(input.events && { events: input.events }),
          lastFailureAt: null,
          lastFailure: null,
        },
      })
      .returning();
    return row!;
  }

  /** Every subscription, the oldest first */
  async subscriptions(): Promise<PushSubscriptionRow[]> {
    return this.#db.select().from(pushSubscriptions).orderBy(asc(pushSubscriptions.id));
  }

  async subscription(id: number): Promise<PushSubscriptionRow | undefined> {
    const [row] = await this.#db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, id));
    return row;
  }

  /** Sets which events a device is told of; the kinds not named keep their value */
  async setEvents(id: number, events: Record<string, boolean>): Promise<PushSubscriptionRow | undefined> {
    const [row] = await this.#db
      .update(pushSubscriptions)
      .set({ events: sql`${pushSubscriptions.events} || ${JSON.stringify(events)}::jsonb` })
      .where(eq(pushSubscriptions.id, id))
      .returning();
    return row;
  }

  /** Forgets a device; whether there was one */
  async remove(id: number): Promise<boolean> {
    const rows = await this.#db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id)).returning({ id: pushSubscriptions.id });
    return rows.length > 0;
  }

  /** Forgets the device behind an endpoint, as the browser that unsubscribes knows it; whether there was one */
  async removeEndpoint(endpoint: string): Promise<boolean> {
    const rows = await this.#db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).returning({ id: pushSubscriptions.id });
    return rows.length > 0;
  }

  async recordSuccess(id: number, at = new Date()): Promise<void> {
    await this.#db.update(pushSubscriptions).set({ lastSuccessAt: at.toISOString() }).where(eq(pushSubscriptions.id, id));
  }

  async recordFailure(id: number, problem: string, at = new Date()): Promise<void> {
    await this.#db
      .update(pushSubscriptions)
      .set({ lastFailureAt: at.toISOString(), lastFailure: problem.slice(0, 300) })
      .where(eq(pushSubscriptions.id, id));
  }
}
