import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FakeNetworkRecord } from '@shipcast/engine';
import { ContentPack, parseLaunchConfig } from '@shipcast/schema';
import {
  activePublishJob,
  checkScale,
  expectedKinds,
  parseExercise,
  planScale,
  SCALE_CHANNELS,
  scaleLaunchYml,
  scaleMarkdown,
  scalePack,
  scaleTargetProblems,
  solidPng,
  type CheckInput,
  type ExerciseEvent,
  type RegistryPiece,
  type ScalePlan,
} from '../src/index.ts';

const START = new Date('2026-10-30T10:00:00Z');
const PREVIEW_ENV = { SHIPCAST_PREVIEW_FAKE_NETWORKS: '1', SHIPCAST_APP_TLS: 'proxy', SHIPCAST_DATABASE_URL: 'postgres://s:p@pgbouncer:5432/shipcast_preview' };

test('the plan: every piece once, over the window, launches overlapping and pieces due in pairs', () => {
  const plan = planScale({ run: 'r1', pieces: 200, start: START, durationMs: 24 * 3600_000 });
  const pieces = plan.launches.flatMap((l) => Object.entries(l.times));
  assert.equal(pieces.length, 200);
  assert.equal(plan.launches.length, Math.ceil(200 / SCALE_CHANNELS.length));
  assert.equal(new Set(plan.launches.map((l) => l.repo)).size, plan.launches.length);
  assert.ok(plan.launches.every((l) => l.marker === `[scale r1 ${l.index}]`));
  const times = pieces.map(([, at]) => Date.parse(at));
  assert.ok(times.every((t) => t >= START.getTime() && t < START.getTime() + 24 * 3600_000));
  assert.equal(plan.start, new Date(Math.min(...times)).toISOString());
  const perMinute = new Map<number, number>();
  for (const t of times) perMinute.set(t, (perMinute.get(t) ?? 0) + 1);
  assert.ok([...perMinute.values()].some((n) => n >= 2), 'some pieces of different launches come due at once');
  // The first launch's pieces are spread over the day, not one after the other
  const first = Object.values(plan.launches[0]!.times).map((t) => Date.parse(t));
  assert.ok(Math.max(...first) - Math.min(...first) > 6 * 3600_000);
});

test("a seeded launch's pack and launch.yml are what the schemas take, and only its channels are on", () => {
  const plan = planScale({ run: 'r1', pieces: SCALE_CHANNELS.length + 3, start: START, durationMs: 3600_000 });
  for (const launch of plan.launches) {
    const pack = ContentPack.safeParse(scalePack(launch));
    assert.ok(pack.success, pack.success ? '' : JSON.stringify(pack.error.issues));
    const config = parseLaunchConfig(scaleLaunchYml(launch, 'personal'));
    assert.ok(config.ok);
    for (const c of SCALE_CHANNELS) assert.equal(config.value.publishing[c], launch.times[c] ? 'auto' : 'off', c);
    assert.equal(config.value.publishing.blog, 'off');
  }
  const png = solidPng(4, 2, [1, 2, 3]);
  assert.deepEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test('the driver refuses anything that is not the preview', () => {
  assert.deepEqual(scaleTargetProblems(PREVIEW_ENV, 'shipcast_preview'), []);
  assert.ok(scaleTargetProblems({ ...PREVIEW_ENV, SHIPCAST_PREVIEW_FAKE_NETWORKS: '0' }, 'shipcast_preview').length > 0);
  assert.ok(scaleTargetProblems({ ...PREVIEW_ENV, SHIPCAST_DATABASE_URL: 'postgres://s:p@pgbouncer:5432/shipcast' }, 'shipcast').length >= 2);
  assert.ok(scaleTargetProblems(PREVIEW_ENV, 'shipcast').some((p) => p.includes('Postgres says')), 'a URL that lies about its database is caught by Postgres');
  assert.ok(scaleTargetProblems({ ...PREVIEW_ENV, COMPOSE_PROJECT_NAME: 'shipcast' }, 'shipcast_preview').some((p) => p.includes('compose project')));
  assert.ok(scaleTargetProblems({ ...PREVIEW_ENV, SCALE_URL: 'https://shipcast.josegarrido.dev' }, 'shipcast_preview').some((p) => p.includes('production')));
});

test('the publish job running now is found in the API’s work list', () => {
  const jobs = [
    { id: '1', title: 'Automation round', state: 'running' },
    { id: '2', title: 'Publishing a launch', state: 'running', queued: true },
    { id: '3', title: 'Publishing a launch', state: 'running', queued: false },
  ];
  assert.equal(activePublishJob(jobs)?.id, '3');
  assert.equal(activePublishJob(jobs.slice(0, 2)), undefined);
});

test("a driver stopped mid-line leaves a log whose last line is skipped", () => {
  const event: ExerciseEvent = { at: '2026-10-30T10:00:00Z', kind: 'page', replica: 'a', ok: true, status: 200, ms: 12 };
  assert.deepEqual(parseExercise(`${JSON.stringify(event)}\n{"at":"2026-10-30T10:01`), [event]);
});

// ---- the check, on fixtures ----

/** Two launches: launch 0 on bluesky, mastodon, youtube and reddit; launch 1 on telegram and discord */
function fixturePlan(): ScalePlan {
  const at = (minutes: number) => new Date(START.getTime() + minutes * 60_000).toISOString();
  return {
    run: 'rfx',
    createdAt: at(-10),
    start: at(0),
    end: at(50),
    pieces: 6,
    launches: [
      { index: 0, repo: 'shipcast-scale/rfx-0', ref: 'v1.0.0', marker: '[scale rfx 0]', launchId: 10, times: { bluesky: at(0), mastodon: at(10), youtube: at(20), reddit: at(30) } },
      { index: 1, repo: 'shipcast-scale/rfx-1', ref: 'v1.0.0', marker: '[scale rfx 1]', launchId: 11, times: { telegram: at(40), discord: at(50) } },
    ],
  };
}

let ids = 0;
const sent = (marker: string | null, channel: string, kind: string, minutesAfterStart: number, externalId = `preview-${channel}-${++ids}`): FakeNetworkRecord => ({
  id: ids,
  at: new Date(START.getTime() + minutesAfterStart * 60_000).toISOString(),
  process: 'worker@a',
  channel,
  action: 'publish',
  kind,
  externalId,
  marker,
  detail: '{}',
});
const row = (launchId: number, channel: string, kind: string, externalId: string | null, status = 'live'): RegistryPiece => ({ launchId, channel, kind, status, externalId, scheduledAt: null, publishedAt: START.toISOString() });

/** Every piece out once, the registry agreeing: the baseline each scenario breaks one way */
function allGood(): Pick<CheckInput, 'registry' | 'ledger'> {
  const plan = fixturePlan();
  const ledger: FakeNetworkRecord[] = [];
  const registry: RegistryPiece[] = [];
  for (const launch of plan.launches) {
    for (const [channel, due] of Object.entries(launch.times)) {
      for (const kind of expectedKinds(channel)) {
        const entry = sent(launch.marker, channel, kind, (Date.parse(due) - START.getTime()) / 60_000 + 1);
        ledger.push(entry);
        registry.push(row(launch.launchId!, channel, kind, entry.externalId));
      }
    }
  }
  return { registry, ledger };
}

const input = (over: Partial<CheckInput> = {}): CheckInput => ({ plan: fixturePlan(), ...allGood(), unknown: [], exercise: [], secrets: [], now: new Date(START.getTime() + 3 * 3600_000), ...over });

test('the check passes when the plan, the registry and the networks agree on every piece', () => {
  const summary = checkScale(input());
  assert.equal(summary.verdict, 'pass', summary.problems.join('; '));
  assert.equal(summary.counts.pieces, 7, 'YouTube is two pieces');
  assert.equal(summary.counts.ok, 7);
  assert.equal(summary.delays.maxSeconds, 60);
  assert.match(scaleMarkdown(summary), /^# Scale test rfx: PASS/);
});

test('a piece sent twice is a duplicate, whatever the registry says', () => {
  const base = allGood();
  const twice = base.ledger.find((e) => e.channel === 'youtube' && e.kind === 'post:video')!;
  const summary = checkScale(input({ ...base, ledger: [...base.ledger, { ...twice, id: 999, externalId: 'preview-youtube-again' }] }));
  assert.equal(summary.verdict, 'fail');
  assert.equal(summary.counts.duplicate, 1);
  assert.deepEqual(summary.pieces.filter((p) => p.state === 'duplicate').map((p) => `${p.channel} ${p.kind} ${p.ledger}`), ['youtube post:video 2']);
});

test('the registry and the network disagreeing is a mismatch, three ways', () => {
  const base = allGood();
  const ledger = base.ledger.filter((e) => e.channel !== 'telegram');
  const registry = base.registry.filter((r) => r.channel !== 'discord').map((r) => (r.channel === 'bluesky' ? { ...r, externalId: 'preview-bluesky-other' } : r));
  const summary = checkScale(input({ registry, ledger }));
  assert.deepEqual(
    summary.pieces.filter((p) => p.state === 'mismatch').map((p) => `${p.channel}: ${p.why}`),
    [
      `bluesky: the registry says preview-bluesky-other, the network ${base.ledger[0]!.externalId}`,
      'telegram: the registry says it is out; the network never got it',
      'discord: the network has it; the registry does not',
    ],
  );
  assert.equal(summary.verdict, 'fail');
});

test('a piece not out after its grace is missed; one still inside it is pending', () => {
  const base = allGood();
  const without = (e: { channel: string }) => e.channel !== 'discord';
  const late = checkScale(input({ registry: base.registry.filter(without), ledger: base.ledger.filter(without) }));
  assert.equal(late.counts.missed, 1);
  assert.equal(late.verdict, 'fail');
  const early = checkScale(input({ registry: base.registry.filter(without), ledger: base.ledger.filter(without), now: new Date(START.getTime() + 55 * 60_000) }));
  assert.equal(early.counts.pending, 1);
  assert.equal(early.verdict, 'incomplete');
});

test('a worker killed mid-send leaves an unknown piece, told apart by whether the network got it', () => {
  const base = allGood();
  const without = (e: { channel: string }) => e.channel !== 'mastodon' && e.channel !== 'reddit';
  const summary = checkScale(
    input({
      registry: base.registry.filter(without),
      ledger: base.ledger.filter((e) => e.channel !== 'reddit'),
      unknown: [
        { launchId: 10, channel: 'mastodon', kind: 'post' },
        { launchId: 10, channel: 'reddit', kind: 'post' },
      ],
    }),
  );
  assert.equal(summary.counts.unknown, 2);
  assert.match(summary.pieces.find((p) => p.channel === 'mastodon')!.why!, /must not Try again/);
  assert.match(summary.pieces.find((p) => p.channel === 'reddit')!.why!, /Try again sends it once/);
  assert.equal(summary.counts.mismatch, 0, 'the network-only Mastodon post is not counted twice');
  assert.equal(summary.verdict, 'fail');
});

test('outside the plan, every preview post is matched between the registry and the networks', () => {
  const base = allGood();
  const summary = checkScale(
    input({
      // A production piece restored into the preview went out on a fake network, and the registry knows it
      ledger: [...base.ledger, sent(null, 'instagram', 'post', 5, 'preview-instagram-restored'), sent(null, 'newsletter', 'issue:en', 6, 'preview-newsletter-lost')],
      registry: [...base.registry, row(6, 'instagram', 'post', 'preview-instagram-restored'), row(6, 'threads', 'post', 'preview-threads-ghost'), row(5, 'devto', 'post', 'real-devto-id')],
    }),
  );
  assert.equal(summary.orphans.ledgerOnly, 1);
  assert.equal(summary.orphans.registryOnly, 1);
  assert.deepEqual(summary.orphans.examples, ['network only: newsletter issue:en preview-newsletter-lost', 'registry only: launch 6 threads post preview-threads-ghost']);
  assert.equal(summary.verdict, 'fail');
});

test('the exercise: failed requests, stale settings, failed callbacks and lost secrets each fail the run', () => {
  const at = START.toISOString();
  const e = (kind: string, ok: boolean, replica = 'a', ms = 10, detail?: string): ExerciseEvent => ({ at, kind, replica, ok, status: ok ? 200 : 502, ms, ...(detail && { detail }) });
  const exercise = [e('page', true, 'a', 10), e('page', true, 'b', 30), e('page', false, 'b', 5), e('settings-save', true), e('settings-read', false, 'b'), e('oauth-start', true), e('oauth-callback', false, 'b'), e('secret', false, '-', 0, 'scale-rfx-3')];
  const summary = checkScale(input({ exercise, secrets: [{ label: 'scale-rfx-3', accountId: null, secretFound: false }] }));
  assert.equal(summary.failedRequests, 1, 'the page that failed; a stale read, a callback and a secret are counted on their own');
  assert.deepEqual(summary.settings, { saves: 1, staleReads: 1 });
  assert.deepEqual(summary.oauth, { started: 1, callbacks: 1, failedCallbacks: 1 });
  assert.deepEqual(summary.secrets, { written: 1, lost: 1, examples: ['scale-rfx-3'] });
  assert.equal(summary.exercise.page!.total, 3);
  assert.equal(summary.exercise.page!.p95Ms, 30);
  assert.equal(summary.problems.length, 4);
  assert.equal(summary.verdict, 'fail');
});

test("during a rollout a replica that stopped answering is counted apart, never a request it answered badly", () => {
  const at = START.toISOString();
  const exercise: ExerciseEvent[] = [
    { at, kind: 'page', replica: '172.18.0.5', ok: false, status: 0, ms: 3, detail: 'connect ECONNREFUSED' },
    { at, kind: 'settings-read', replica: '172.18.0.5', ok: false, status: 0, ms: 3 },
    { at, kind: 'page', replica: '172.18.0.6', ok: true, status: 200, ms: 40 },
  ];
  assert.equal(checkScale(input({ exercise })).verdict, 'fail');
  const rolled = checkScale(input({ exercise, ignoreUnreachable: true }));
  assert.equal(rolled.verdict, 'pass', rolled.problems.join('; '));
  assert.equal(rolled.unreachable, 2);
  assert.equal(checkScale(input({ exercise: [...exercise, { at, kind: 'page', replica: '172.18.0.6', ok: false, status: 502, ms: 9 }], ignoreUnreachable: true })).failedRequests, 1, 'a 502 is always a failure');
});
