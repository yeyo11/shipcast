import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Brand, DEFAULT_TRIGGER_RULES, parseLaunchConfig, ShipcastError, type TriggerRule } from '@shipcast/schema';
import { claimEvent, draftLaunch, TriggerService, type GitHubEvent } from '../src/index.ts';
import { FakeGitHub, memoryRegistry, mockRunner, scriptedModel, submitParts } from '../src/testing/index.ts';

/*
 * The launch model's seventh phase, its triggers (docs/launch-triggers.md): with the owner's rules a
 * GitHub event creates a launch by them, launch.yml is optional input, and a dedupe key keeps a
 * second event or a re-run from launching the same thing twice. Without the rules (the flag off),
 * claimEvent is today's, which detect.test.ts pins.
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
const VALID = 'enabled: true\nbrand: personal\n';

const release = (id: string, repo: string, tag: string, prerelease = false): GitHubEvent => ({
  id,
  type: 'release',
  repo,
  tag,
  prerelease,
  url: `https://github.com/${repo}/releases/tag/${tag}`,
  at: '2026-10-30T10:00:00Z',
});
const madePublic = (id: string, repo: string): GitHubEvent => ({ id, type: 'public', repo, at: '2026-10-30T10:00:00Z' });

async function setup(files: Record<string, string> = {}, rules?: TriggerRule[]) {
  const registry = await memoryRegistry();
  const github = new FakeGitHub({ files });
  const triggers = new TriggerService({ registry });
  if (rules) await triggers.save(rules);
  return { registry, github, triggers, options: { github, registry, brand, triggers } };
}

const rule = (over: Partial<TriggerRule> & Pick<TriggerRule, 'id' | 'event'>): TriggerRule => ({ enabled: true, repos: '*', prereleases: false, channels: null, ...over });

test('without the rules too, a repo made public by webhook and by poll is one launch: every claim carries its dedupe key', async () => {
  const { registry, github } = await setup({ 'yeyo11/tool/.github/launch.yml@HEAD': `${VALID}triggers:\n  public: true\n` });
  const byWebhook = await claimEvent(madePublic('webhook-public-yeyo11/tool', 'yeyo11/tool'), { github, registry, brand });
  const byPoll = await claimEvent(madePublic('4567', 'yeyo11/tool'), { github, registry, brand });
  assert.equal(byWebhook.result, 'claimed');
  // Before, with the flag off, the claim carried no key and these were two launches of one event
  assert.equal(byPoll.result, 'already-claimed');
  assert.ok('launch' in byWebhook && (await registry.launches.dedupeKey(byWebhook.launch.id)) === 'github-public:yeyo11/tool');
});

test('a claim by hand, an article or a release without the rules is keyed too, so a later trigger finds it', async () => {
  const registry = await memoryRegistry();
  const manual = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'manual', kind: 'launch', brand: 'personal' });
  const article = await registry.launches.claim({ repo: 'yeyo11/launches', ref: 'article:why', trigger: 'article', kind: 'launch', brand: 'personal' });
  assert.equal(await registry.launches.dedupeKey(manual.launch.id), 'github-release:yeyo11/claudio@v1.0.0');
  assert.equal(await registry.launches.dedupeKey(article.launch.id), 'article:why');
  const { options } = await setup({ 'yeyo11/claudio/.github/launch.yml@v1.0.0': VALID });
  const byRule = await claimEvent(release('1', 'yeyo11/claudio', 'v1.0.0'), { ...options, registry });
  assert.ok('launch' in byRule);
  assert.deepEqual({ result: byRule.result, id: byRule.launch.id }, { result: 'already-claimed', id: manual.launch.id });
});

test('the default rules decide as launch.yml alone did', async () => {
  const { options } = await setup({ 'yeyo11/claudio/.github/launch.yml@v1.0.0': VALID, 'yeyo11/off/.github/launch.yml@v1.0.0': 'enabled: false\nbrand: personal\n' });
  assert.deepEqual(await options.triggers.rules(), DEFAULT_TRIGGER_RULES);
  const outcomes = [
    await claimEvent(release('1', 'yeyo11/claudio', 'v1.0.0'), options),
    await claimEvent(release('2', 'yeyo11/plain', 'v1.0.0'), options),
    await claimEvent(release('3', 'yeyo11/off', 'v1.0.0'), options),
    await claimEvent(release('4', 'yeyo11/claudio', 'v2.0.0-rc.1', true), options),
  ];
  assert.deepEqual(
    outcomes.map((o) => (o.result === 'ignored' ? o.reason : o.result)),
    ['claimed', 'no .github/launch.yml, and the rule "releases" launches only repos with one', 'launch.yml has enabled: false', 'a pre-release, which no trigger rule takes'],
  );
});

test('a claim carries its dedupe key: a second event of the same release, or a re-run, launches nothing', async () => {
  const { registry, options } = await setup({ 'yeyo11/claudio/.github/launch.yml@v1.0.0': VALID });
  const first = await claimEvent(release('1', 'yeyo11/claudio', 'v1.0.0'), options);
  const again = await claimEvent(release('webhook-99', 'yeyo11/claudio', 'v1.0.0'), options);
  assert.equal(first.result, 'claimed');
  assert.equal(again.result, 'already-claimed');
  assert.ok('launch' in first && 'launch' in again && first.launch.id === again.launch.id);
  assert.equal(await registry.launches.dedupeKey(first.launch.id), 'github-release:yeyo11/claudio@v1.0.0');
});

test('a repo made public by webhook and by poll is one launch under the rules', async () => {
  const { registry, options } = await setup({ 'yeyo11/tool/.github/launch.yml@HEAD': `${VALID}triggers:\n  public: true\n` });
  const byWebhook = await claimEvent(madePublic('webhook-public-yeyo11/tool', 'yeyo11/tool'), options);
  const byPoll = await claimEvent(madePublic('4567', 'yeyo11/tool'), options);
  assert.equal(byWebhook.result, 'claimed');
  assert.equal(byPoll.result, 'already-claimed');
  assert.equal((await registry.launches.recent()).length, 1);
});

test('rules choose by event and repo, in order; a disabled rule, and an event no rule matches, create nothing', async () => {
  const { options } = await setup(
    { 'yeyo11/claudio/.github/launch.yml@v1.0.0': VALID, 'yeyo11/claudio/.github/launch.yml@v1.1.0-beta.1': VALID, 'other/lib/.github/launch.yml@v1.0.0': VALID },
    [rule({ id: 'off', event: 'release', repos: 'yeyo11/*', enabled: false }), rule({ id: 'claudio', event: 'release', repos: 'Yeyo11/Claudio', prereleases: true })],
  );
  assert.equal((await claimEvent(release('1', 'yeyo11/claudio', 'v1.0.0'), options)).result, 'claimed');
  assert.equal((await claimEvent(release('2', 'yeyo11/claudio', 'v1.1.0-beta.1', true), options)).result, 'claimed', 'this rule takes pre-releases');
  const other = await claimEvent(release('3', 'other/lib', 'v1.0.0'), options);
  assert.deepEqual(other.result === 'ignored' && other.reason, 'no trigger rule matches');
});

test('a repo’s own launch.yml still says no for itself, whatever the rule', async () => {
  const { options } = await setup({ 'yeyo11/quiet/.github/launch.yml@v1.0.0': `${VALID}triggers:\n  release: false\n` }, [rule({ id: 'all', event: 'release', channels: ['blog'] })]);
  const outcome = await claimEvent(release('1', 'yeyo11/quiet', 'v1.0.0'), options);
  assert.deepEqual(outcome.result === 'ignored' && outcome.reason, 'releases do not trigger launches in this repo');
});

test('a release whose launch the owner removed is not launched again', async () => {
  const { options } = await setup({ 'yeyo11/claudio/.github/launch.yml@v1.0.0': VALID });
  const asked: string[] = [];
  const removed = async (key: string) => {
    asked.push(key);
    return true;
  };
  const outcome = await claimEvent(release('1', 'yeyo11/claudio', 'v1.0.0'), { ...options, removed });
  assert.deepEqual(outcome.result === 'ignored' && outcome.reason, 'its launch was deleted');
  assert.deepEqual(asked, ['github-release:yeyo11/claudio@v1.0.0']);
  // Without the rules too (launch-delete on, launch-triggers off)
  const legacy = await claimEvent(release('2', 'yeyo11/claudio', 'v1.0.0'), { github: options.github, registry: options.registry, brand, removed });
  assert.equal(legacy.result, 'ignored');
});

test('a repo with no launch.yml is launched on the rule’s channels, which its draft reads', async () => {
  const { registry, github, options } = await setup(
    { 'yeyo11/launches/brand.yml@HEAD': 'id: personal\ndisplayName: Me\nsite: https://josegarrido.dev\ngithub: yeyo11\n' },
    [rule({ id: 'everything', event: 'release', channels: ['blog', 'bluesky'] })],
  );
  const outcome = await claimEvent(release('1', 'yeyo11/plain', 'v1.0.0'), options);
  assert.equal(outcome.result, 'claimed');
  assert.ok('launch' in outcome);
  const kept = await registry.launchStore.channels(outcome.launch.id);
  const config = parseLaunchConfig(kept.source ?? '');
  assert.ok(config.ok);
  assert.equal(config.value.publishing.blog, 'approval');
  assert.equal(config.value.publishing.bluesky, 'approval');
  assert.equal(config.value.publishing.mastodon, 'off');
  assert.deepEqual(kept.rows.filter((r) => r.mode !== 'off').map((r) => r.channel).sort(), ['blog', 'bluesky']);

  const article = { title: 'plain', description: 'd', markdown: 'b' };
  const pack = {
    schemaVersion: 1,
    kind: 'launch',
    project: { name: 'plain', repo: 'https://github.com/yeyo11/plain', version: 'v1.0.0' },
    analysis: { summary: 's', implemented: ['x'], planned: [], documentedOnly: [], limitations: [] },
    article: { en: { slug: 'plain', ...article }, es: { slug: 'plain-es', ...article } },
    bluesky: { lang: 'en', text: 'b' },
  };
  const drafted = await draftLaunch(outcome.launch, brand, {
    github,
    aiRunner: mockRunner(scriptedModel(submitParts(pack))),
    registry,
    launchesRepo: 'yeyo11/launches',
    checkout: async () => ({ hostPath: '/h' }),
    now: () => new Date('2026-10-30T00:00:00Z'),
    fetch: (async () => new Response(null, { status: 404 })) as typeof fetch,
    triggers: options.triggers,
  });
  assert.equal(drafted.ok, true, drafted.ok ? '' : drafted.problems.join('\n'));
  const files = github.opened[0]!.files.map((f) => f.path);
  assert.ok(files.some((p) => p.endsWith('/bluesky.md')), 'the rule’s channel is drafted');
  assert.ok(!files.some((p) => p.endsWith('/mastodon.md')), 'a channel the rule leaves out is not');
});

test('without the rules, a repo with no launch.yml still fails its draft as before', async () => {
  const { registry, github } = await setup();
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/plain', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  const drafted = await draftLaunch(launch, brand, { github, aiRunner: mockRunner(scriptedModel([])), registry, launchesRepo: 'yeyo11/launches', checkout: async () => ({ hostPath: '/h' }) });
  assert.deepEqual(drafted.ok ? [] : drafted.problems, ['yeyo11/plain has no .github/launch.yml at v1.0.0']);
});

test('the rules are saved whole and checked; a rule a later schema refuses is dropped on reading', async () => {
  const { registry, triggers } = await setup();
  await assert.rejects(triggers.save([rule({ id: 'a', event: 'release' }), rule({ id: 'a', event: 'public' })]), (error: unknown) => error instanceof ShipcastError && /two rules are called a/.test(error.message));
  await assert.rejects(triggers.save([{ ...rule({ id: 'b', event: 'release' }), repos: 'not a repo' }]), /repo pattern/);
  const saved = await triggers.save([{ id: 'c', event: 'release', repos: 'yeyo11/*' }]);
  assert.deepEqual(saved, [rule({ id: 'c', event: 'release', repos: 'yeyo11/*' })]);
  await registry.settings.setSetting('triggers', [...saved, { id: 'd', event: 'tag' }]);
  assert.deepEqual(await triggers.rules(), saved);
  await triggers.save([]);
  assert.deepEqual(await triggers.rules(), [], 'no rules: no event creates a launch');
});
