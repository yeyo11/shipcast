import type { Channel } from '@shipcast/schema';
import type { Launch, LaunchStatus, NewLaunch, Post, PostKind, PostStatus, Repositories } from '../repositories/index.ts';

/*
 * Registry fixtures: the rows most tests start from, written through the registry's own methods so
 * they hold what the code would have written. A launch defaults to claudio v1.0.0 of the personal
 * brand, drafted from a pull request on yeyo11/launches.
 */

export const LAUNCHES_REPO = 'yeyo11/launches';

export interface LaunchFixture {
  repo?: string;
  ref?: string;
  trigger?: NewLaunch['trigger'];
  kind?: NewLaunch['kind'];
  brand?: string;
  status?: LaunchStatus;
  /** Where the drafts are; a pull request on the launches repo unless said */
  detail?: string | null;
}

/** A claimed launch moved to `status` (drafted unless said) */
export async function aLaunch(registry: Pick<Repositories, 'launches'>, fixture: LaunchFixture = {}): Promise<Launch> {
  const { launch } = await registry.launches.claim({
    repo: fixture.repo ?? 'yeyo11/claudio',
    ref: fixture.ref ?? 'v1.0.0',
    trigger: fixture.trigger ?? 'release',
    kind: fixture.kind ?? 'launch',
    brand: fixture.brand ?? 'personal',
  });
  const status = fixture.status ?? 'drafted';
  const detail = fixture.detail === undefined ? `https://github.com/${LAUNCHES_REPO}/pull/3` : fixture.detail;
  return registry.launches.setStatus(launch.id, status, detail);
}

export interface PostFixture {
  channel: Channel;
  kind?: PostKind;
  /** `<channel>-<n>` unless said; null for a piece with no id on the network */
  externalId?: string | null;
  url?: string | null;
  accountId?: number | null;
  status?: Exclude<PostStatus, 'scheduled'>;
}

/** Records each piece on the launch, in order; a status other than live is set after it is recorded */
export async function withPosts(registry: Pick<Repositories, 'posts'>, launchId: number, pieces: readonly PostFixture[]): Promise<Post[]> {
  const out: Post[] = [];
  for (const [i, p] of pieces.entries()) {
    const externalId = p.externalId === undefined ? `${p.channel}-${i + 1}` : p.externalId;
    const { post } = await registry.posts.recordPost({
      launchId,
      channel: p.channel,
      kind: p.kind ?? 'post',
      externalId,
      url: p.url === undefined ? `https://${p.channel}.example/${externalId ?? i + 1}` : p.url,
      accountId: p.accountId ?? null,
    });
    out.push(p.status && p.status !== 'live' ? await registry.posts.updatePost(post.id, { status: p.status }) : post);
  }
  return out;
}

/** A published launch with its pieces out */
export async function aPublishedLaunch(registry: Pick<Repositories, 'launches' | 'posts' | 'metrics'>, pieces: readonly PostFixture[], fixture: LaunchFixture = {}): Promise<{ launch: Launch; posts: Post[] }> {
  const launch = await aLaunch(registry, { ...fixture, status: 'published' });
  return { launch, posts: await withPosts(registry, launch.id, pieces) };
}

/** Scheduled rows, one per channel, as the scheduling writes them */
export async function withScheduled(registry: Pick<Repositories, 'posts'>, launchId: number, times: Partial<Record<Channel, Date>>): Promise<Post[]> {
  const out: Post[] = [];
  for (const [channel, at] of Object.entries(times) as Array<[Channel, Date]>) {
    const post = await registry.posts.schedulePost(launchId, channel, at);
    if (!post) throw new Error(`${channel} of launch ${launchId} is out already: it cannot be scheduled`);
    out.push(post);
  }
  return out;
}

/** One reading per source, at `takenAt`, each optionally on a piece */
export async function withMetrics(
  registry: Pick<Repositories, 'launches' | 'posts' | 'metrics'>,
  launchId: number,
  readings: ReadonlyArray<{ source: string; values: Record<string, number>; postId?: number | null }>,
  takenAt: Date = new Date('2026-11-03T09:00:00.000Z'),
): Promise<void> {
  for (const r of readings) await registry.metrics.recordMetrics(launchId, r.source, r.values, takenAt, r.postId ?? null);
}
