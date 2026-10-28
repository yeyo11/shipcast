import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Brand } from '@shipcast/schema';
import { publishLaunch, PublishingService, type Publishers, type Registry } from '../src/index.ts';
import { aLaunch, FakeConnectors, FakeGitHub, LAUNCHES_REPO, memoryRegistry } from '../src/testing/index.ts';

/*
 * The exit test of phase 2 (docs/plans/performance-refactor.md): the round and a publish job running
 * the same launch at the same moment get exactly one post per piece. Without the publishing service
 * the same race posts twice, which the first test shows, so the second proves the fix and not luck.
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
const D = 'launches/claudio/v1.0.0';
const pack = {
  schemaVersion: 1,
  kind: 'launch',
  project: { name: 'claudio', repo: 'https://github.com/yeyo11/claudio', version: 'v1.0.0' },
  analysis: { summary: 's', implemented: ['x'], planned: [], documentedOnly: [], limitations: [] },
  article: { en: { slug: 'claudio', title: 'T', description: 'D', markdown: 'B' } },
  bluesky: { lang: 'en', text: 'bluesky text' },
  mastodon: { lang: 'en', text: 'mastodon text' },
  telegram: { text: 'telegram text' },
  discord: { text: 'discord text' },
  threads: { text: 'threads text' },
};
const LAUNCH_YML = 'enabled: true\nbrand: personal\npublishing:\n  devto: off\n  instagram: off\n  githubDiscussions: off\n  telegram: approval\n  discord: approval\n  threads: approval\n';
const CHANNELS = ['bluesky', 'mastodon', 'telegram', 'discord', 'threads'] as const;

function github(): FakeGitHub {
  return new FakeGitHub({
    pullRequestState: 'merged',
    files: {
      [`${LAUNCHES_REPO}/${D}/pack.json@HEAD`]: JSON.stringify(pack),
      [`${LAUNCHES_REPO}/src/content/posts/en/claudio.md@HEAD`]: '---\ntitle: "Title"\ndescription: "Description"\n---\n\nBody.\n',
      'yeyo11/claudio/.github/launch.yml@v1.0.0': LAUNCH_YML,
    },
  });
}

const site = (async (input: string | URL | Request) =>
  String(input).endsWith('/og.jpg') ? new Response(new Uint8Array([0xff, 0xd8, 0xff])) : new Response(null, { status: 200 })) as typeof fetch;

/** Each publish takes a while, as a network does, so two runs overlap on every channel */
function slow(publishers: Publishers): Publishers {
  const out: Record<string, unknown> = {};
  for (const [channel, publisher] of Object.entries(publishers)) {
    out[channel] = {
      ...publisher,
      publish: async (input: unknown) => {
        await new Promise((r) => setTimeout(r, 15));
        return (publisher as { publish(i: unknown): Promise<unknown> }).publish(input);
      },
    };
  }
  return out as Publishers;
}

async function setup(): Promise<{ registry: Registry; fake: FakeConnectors; launchId: number }> {
  const registry = await memoryRegistry();
  const launch = await aLaunch(registry);
  return { registry, fake: new FakeConnectors(), launchId: launch.id };
}

const sends = (fake: FakeConnectors) => Object.fromEntries(CHANNELS.map((c) => [c, fake.log.filter((l) => l === `${c} publish`).length]));

test('without the publishing service, two runs of one launch at once post twice (the hazard)', async () => {
  const { registry, fake, launchId } = await setup();
  const launch = (await registry.launches.get(launchId))!;
  const deps = { github: github(), registry, launchesRepo: LAUNCHES_REPO, publishers: slow(fake.publishers([...CHANNELS])), fetch: site };
  await Promise.all([publishLaunch(launch, brand, deps), publishLaunch(launch, brand, deps)]);
  assert.ok(Object.values(sends(fake)).some((n) => n > 1), `some channel went out twice: ${JSON.stringify(sends(fake))}`);
});

test('the round and a publish job at the same moment: exactly one post per piece', async () => {
  const { registry, fake, launchId } = await setup();
  const launch = (await registry.launches.get(launchId))!;
  const service = new PublishingService({ registry, github: github(), launchesRepo: LAUNCHES_REPO });
  const connectors = { publishers: slow(fake.publishers([...CHANNELS])), fetch: site };
  const [round, job] = await Promise.all([service.publish(launch, brand, connectors, 'round'), service.publish(launch, brand, connectors, 'job-1')]);

  assert.deepEqual(sends(fake), { bluesky: 1, mastodon: 1, telegram: 1, discord: 1, threads: 1 });
  const posts = (await registry.posts.posts(launchId)).filter((p) => p.kind === 'post');
  assert.deepEqual(posts.map((p) => p.channel).sort(), [...CHANNELS].sort());
  // Whichever run lost a channel's claim left it to the other and said so, never as a failure
  for (const result of [round, job]) assert.ok(result.state !== 'waiting' && result.state !== 'skipped' && result.failures.length === 0);
  // Each piece's attempt is live, held by one run or the other
  const attempts = await service.attempts.ofLaunch(launchId);
  assert.deepEqual(attempts.map((a) => a.state), CHANNELS.map(() => 'live'));

  // The next run, by anyone, sends nothing more and publishes the launch
  const again = await service.publish((await registry.launches.get(launchId))!, brand, connectors, 'job-2');
  assert.equal(again.state, 'published');
  assert.deepEqual(sends(fake), { bluesky: 1, mastodon: 1, telegram: 1, discord: 1, threads: 1 });
});

test('a run that died while sending: Mastodon (idempotent) is sent again, Telegram is left unknown, not reposted', async () => {
  const { registry, fake, launchId } = await setup();
  const service = new PublishingService({ registry, github: github(), launchesRepo: LAUNCHES_REPO });
  // A run claimed both and died before it could say whether they went out
  const long_ago = new Date(Date.now() - 3_600_000);
  for (const channel of ['mastodon', 'telegram']) await service.attempts.claim({ launchId, channel, kind: 'post' }, { holder: 'dead', idempotent: false, leaseMs: 1000, now: long_ago });

  const result = await service.publish((await registry.launches.get(launchId))!, brand, { publishers: fake.publishers([...CHANNELS]), fetch: site }, 'job-2');
  assert.ok(result.state === 'partial');
  assert.equal(sends(fake).mastodon, 1, 'Mastodon takes the idempotency key: sending again is safe');
  assert.equal(sends(fake).telegram, 0, 'Telegram could post twice: left for the owner');
  assert.deepEqual(result.heldElsewhere.map((h) => h.channel), ['telegram']);
  assert.match(result.heldElsewhere[0]!.why, /check the channel, then Try again/);

  // Try again on Telegram clears it, and the next run sends it
  await service.retry(launchId, 'telegram');
  await service.publish((await registry.launches.get(launchId))!, brand, { publishers: fake.publishers([...CHANNELS]), fetch: site }, 'job-3');
  assert.equal(sends(fake).telegram, 1);
});
