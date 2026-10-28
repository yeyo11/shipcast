import { deflateSync, crc32 } from 'node:zlib';
import { launchDir, LAUNCH_CONFIG_PATH, mediaPath, redditKind, type FakeNetworkRecord, type Launch } from '@shipcast/engine';
import { SCHEDULABLE_CHANNELS, type Channel } from '@shipcast/schema';
import { fakeNetworks, previewDatabase } from './guard.ts';

/*
 * The scale test of docs/plans/goal-refactor.md (phase 10), against a preview with fake networks:
 * the plan of the launches it seeds and when each piece comes due, the files those launches need
 * (their pack, launch.yml, article and image, served by the preview's fixtures), and the check at the
 * end, which compares three independent records of every piece: the plan (what was due, and when),
 * the registry (what Shipcast says went out) and the fake networks' ledger (what the networks were
 * sent). scripts/scale-test.ts runs it; this module is its logic, without I/O, so it is tested.
 */

/** The channels a scale run schedules: every channel a time can be set for */
export const SCALE_CHANNELS: readonly Channel[] = SCHEDULABLE_CHANNELS;

/** The subreddit every scale launch posts to; the fake network takes any */
export const SCALE_SUBREDDIT = 'shipcast_scale';

/** The marker each launch's texts carry, which the ledger reads back (engine/src/preview/ledger.ts) */
export const scaleMarker = (run: string, index: number) => `[scale ${run} ${index}]`;

/** A run's id: lowercase letters, digits and hyphens, as the marker takes them */
export function runId(at: Date): string {
  return `r${at.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').toLowerCase()}`;
}

export interface PlannedLaunch {
  index: number;
  repo: string;
  ref: string;
  marker: string;
  /** Each of its channels and the moment its piece is due, ISO 8601 */
  times: Partial<Record<Channel, string>>;
  /** Filled in by the seed: the registry's launch and its scheduled rows */
  launchId?: number;
}

export interface ScalePlan {
  run: string;
  createdAt: string;
  start: string;
  end: string;
  pieces: number;
  launches: PlannedLaunch[];
}

export interface PlanOptions {
  run: string;
  /** How many pieces in all (one per launch and channel) */
  pieces: number;
  start: Date;
  /** Over how long the pieces come due */
  durationMs: number;
  channels?: readonly Channel[];
  now?: Date;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * The launches and their pieces' times. Piece k is the launch k ÷ C's channel k mod C, so each
 * launch carries up to every channel, and its slot is a fixed permutation of 0..N−1, so the launches
 * overlap instead of following each other. Slots go two by two to the same minute: pieces of
 * different launches come due at once, which is what makes two workers race for work.
 */
export function planScale(options: PlanOptions): ScalePlan {
  const channels = options.channels ?? SCALE_CHANNELS;
  const n = Math.max(1, Math.floor(options.pieces));
  if (channels.length === 0) throw new Error('a scale plan needs at least one channel');
  let step = Math.max(1, Math.round(n * 0.37));
  while (gcd(step, n) !== 1) step += 1;
  const spacing = options.durationMs / n;
  const launches: PlannedLaunch[] = [];
  for (let k = 0; k < n; k++) {
    const index = Math.floor(k / channels.length);
    const channel = channels[k % channels.length]!;
    const slot = (k * step) % n;
    const at = new Date(options.start.getTime() + Math.floor(slot / 2) * 2 * spacing);
    at.setUTCSeconds(0, 0);
    const launch = (launches[index] ??= { index, repo: `shipcast-scale/${options.run}-${index}`, ref: 'v1.0.0', marker: scaleMarker(options.run, index), times: {} });
    launch.times[channel] = at.toISOString();
  }
  const times = launches.flatMap((l) => Object.values(l.times)).sort();
  return { run: options.run, createdAt: (options.now ?? new Date()).toISOString(), start: times[0]!, end: times.at(-1)!, pieces: n, launches };
}

/** The pieces a channel's scheduled row stands for, as the registry and the ledger name them */
export function expectedKinds(channel: string): string[] {
  if (channel === 'youtube') return ['post:short', 'post:video'];
  if (channel === 'newsletter') return ['issue:en'];
  if (channel === 'reddit') return [redditKind(SCALE_SUBREDDIT)];
  return ['post'];
}

const cardScenes = (marker: string, seconds: number[]) =>
  seconds.map((s, i) => ({ kind: i === 0 ? 'card' : 'cover', ...(i === 0 && { title: 'Scale test', text: marker }), subtitle: `${marker} scene ${i + 1}`, seconds: s, ...(i === 0 && { chapter: 'Start' }) }));

/** A pack holding one piece for each of the launch's channels, every text carrying its marker */
export function scalePack(launch: PlannedLaunch): Record<string, unknown> {
  const m = launch.marker;
  const has = (c: Channel) => launch.times[c] !== undefined;
  const slug = `${launch.repo.split('/')[1]}-scale`;
  const pack: Record<string, unknown> = {
    schemaVersion: 1,
    kind: 'launch',
    project: { name: `Scale ${launch.index}`, repo: `https://github.com/${launch.repo}`, version: launch.ref },
    analysis: { summary: `A launch the scale test made up ${m}`, implemented: ['nothing real'], planned: [], documentedOnly: [], limitations: [] },
    article: { tags: ['scale'], en: { slug, title: `Scale ${launch.index}`, description: `The scale test's launch ${m}`, markdown: `A made-up article ${m}.` } },
  };
  if (has('devto')) pack.devto = { tags: ['scale'] };
  if (has('hashnode')) pack.hashnode = { tags: ['scale'] };
  for (const c of ['bluesky', 'mastodon'] as const) if (has(c)) pack[c] = { lang: 'en', text: `${c} ${m}` };
  for (const c of ['telegram', 'discord', 'threads', 'linkedin'] as const) if (has(c)) pack[c] = { text: `${c} ${m}` };
  if (has('instagram')) pack.instagram = { caption: `instagram ${m}`, summary: `Scale ${launch.index}`, slides: [{ title: 'One', text: 'A slide.' }, { title: 'Two', text: 'Another slide.' }] };
  if (has('newsletter')) pack.newsletter = { en: { subject: `Newsletter ${m}`, previewText: `Preview ${m}`, markdown: `An issue ${m}.` } };
  if (has('reddit')) pack.reddit = [{ subreddit: SCALE_SUBREDDIT, title: `Reddit ${m}`, body: `A post ${m}.` }];
  if (has('githubDiscussions')) pack.githubDiscussions = { title: `Discussion ${m}`, body: `An announcement ${m}.` };
  if (has('youtube')) {
    pack.youtube = {
      short: { title: `Short ${m}`, description: `A Short ${m}`, tags: ['scale'], lang: 'en', scenes: cardScenes(m, [4, 4]) },
      video: { title: `Video ${m}`, description: `A video ${m}`, tags: ['scale'], lang: 'en', scenes: cardScenes(m, [30, 32]) },
    };
  }
  return pack;
}

/** launch.yml: its channels automatic, every other one and the blog off, so nothing goes out but what the plan scheduled */
export function scaleLaunchYml(launch: PlannedLaunch, brand: string): string {
  const lines = ['enabled: true', `brand: ${brand}`, 'publishing:', '  blog: off'];
  for (const c of SCALE_CHANNELS) lines.push(`  ${c}: ${launch.times[c] ? 'auto' : 'off'}`);
  return `${lines.join('\n')}\n`;
}

/** A solid-colour PNG, so the launch image and the video's cover are real images ffmpeg can draw */
export function solidPng(width: number, height: number, rgb: readonly [number, number, number]): Uint8Array {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

export interface ScaleFiles {
  github: Array<{ repo: string; path: string; content: string }>;
  site: Array<{ url: string; content: Uint8Array }>;
}

/** What a seeded launch needs GitHub and the site to answer, for the preview's fixtures */
export function scaleFiles(planned: PlannedLaunch, launch: Launch, options: { launchesRepo: string; site: string; brand: string }): ScaleFiles {
  const pack = scalePack(planned);
  const article = (pack.article as { en: { slug: string; title: string; description: string; markdown: string } }).en;
  const image = solidPng(1200, 630, [20 + (planned.index * 37) % 200, 60, 90]);
  return {
    github: [
      { repo: options.launchesRepo, path: `${launchDir(launch)}/pack.json`, content: JSON.stringify(pack, null, 2) },
      { repo: options.launchesRepo, path: `src/content/posts/en/${article.slug}.md`, content: `---\ntitle: "${article.title}"\ndescription: "${article.description}"\n---\n\n${article.markdown}\n` },
      { repo: launch.repo, path: LAUNCH_CONFIG_PATH, content: scaleLaunchYml(planned, options.brand) },
    ],
    site: [
      { url: `${options.site}${mediaPath(launch, 'og.jpg')}`, content: image },
      { url: `${options.site}${mediaPath(launch, 'og.png')}`, content: image },
    ],
  };
}

// ---- What the driver checks before it touches anything ----

/** The compose project a scale run, a chaos script and their checks may act on, and no other */
export const PREVIEW_PROJECT = 'shipcast-preview';

/**
 * Why the scale driver must not run here, if anything: it seeds launches and schedules pieces, so it
 * only ever acts on a preview with fake networks, its own `…_preview` database (as the URL says and
 * as Postgres itself answers) and the preview's compose project.
 */
export function scaleTargetProblems(env: NodeJS.ProcessEnv, currentDatabase: string | undefined): string[] {
  const problems: string[] = [];
  if (!fakeNetworks(env)) problems.push('this is not a preview with fake networks (SHIPCAST_PREVIEW_FAKE_NETWORKS=1 with SHIPCAST_APP_TLS=proxy on a …_preview database, or off)');
  if (!previewDatabase(env.SHIPCAST_DATABASE_URL)) problems.push('SHIPCAST_DATABASE_URL does not name a …_preview database');
  if (currentDatabase !== undefined && !/_preview$/.test(currentDatabase)) problems.push(`Postgres says this is the database "${currentDatabase}", not a …_preview one`);
  if (env.COMPOSE_PROJECT_NAME !== undefined && env.COMPOSE_PROJECT_NAME !== PREVIEW_PROJECT) problems.push(`the compose project is "${env.COMPOSE_PROJECT_NAME}", not ${PREVIEW_PROJECT}`);
  if (env.SCALE_URL !== undefined) {
    try {
      const host = new URL(env.SCALE_URL).hostname;
      if (host === 'shipcast.josegarrido.dev') problems.push('SCALE_URL is production');
    } catch {
      problems.push(`SCALE_URL is not a URL: ${env.SCALE_URL}`);
    }
  }
  return problems;
}

/** A job of the API's work list (GET /api/v1/jobs), as much as the chaos scripts read of it */
export interface ApiJob {
  id: string;
  title: string;
  state: string;
  queued?: boolean;
  startedAt?: string;
}

/** The publish job running now, if any: the moment chaos (a) kills a worker */
export function activePublishJob(jobs: readonly ApiJob[]): ApiJob | undefined {
  return jobs.find((j) => j.state === 'running' && !j.queued && /^(Publishing|A scheduled post)/i.test(j.title));
}

/** The exercise's log (one JSON object a line); a line cut short by a killed driver is skipped */
export function parseExercise(text: string): ExerciseEvent[] {
  const events: ExerciseEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as ExerciseEvent);
    } catch {
      // the last line of a driver that was stopped mid-write
    }
  }
  return events;
}

/** The secret writes the exercise checked right after each sign-in: `secret` events, labelled in their detail */
export function secretWrites(events: readonly ExerciseEvent[]): SecretWrite[] {
  return events.filter((e) => e.kind === 'secret').map((e) => ({ label: e.detail ?? '?', accountId: null, secretFound: e.ok }));
}

// ---- The check ----

/** A registry row of a piece, as the check reads it */
export interface RegistryPiece {
  launchId: number;
  channel: string;
  kind: string;
  status: string;
  externalId: string | null;
  scheduledAt: string | null;
  publishedAt: string;
}

/** A publish attempt the check needs to know about: one a worker left `unknown` */
export interface UnknownAttempt {
  launchId: number;
  channel: string;
  kind: string;
}

/** One request the exercise made, as scale-test.ts writes it to exercise.jsonl */
export interface ExerciseEvent {
  at: string;
  /** `page`, `settings-save`, `settings-read`, `oauth-start`, `oauth-callback`, `api` */
  kind: string;
  /** The replica that answered (its address) */
  replica: string;
  ok: boolean;
  status: number;
  ms: number;
  detail?: string;
}

/** An account an OAuth round trip made, and whether its secret was found and opened afterwards */
export interface SecretWrite {
  label: string;
  accountId: number | null;
  secretFound: boolean;
}

export interface CheckInput {
  plan: ScalePlan;
  registry: RegistryPiece[];
  /** Every ledger entry of the window, the plan's and any other */
  ledger: FakeNetworkRecord[];
  unknown: UnknownAttempt[];
  exercise: ExerciseEvent[];
  secrets: SecretWrite[];
  now: Date;
  /** How long after its time a piece may still be missing before it counts as missed */
  graceMs?: number;
  /** A piece out later than this after its time is late (a KPI, not a failure) */
  lateMs?: number;
  /**
   * Requests no replica answered (status 0) are counted apart instead of as failures: during a
   * rolling deploy the driver, which reaches each replica by address, may send one to a container in
   * the second it stops; whether a client saw a failure is then the proxy's traffic to say
   */
  ignoreUnreachable?: boolean;
}

export type PieceState = 'ok' | 'duplicate' | 'mismatch' | 'missed' | 'unknown' | 'pending';

export interface PieceResult {
  launch: number;
  launchId: number | undefined;
  channel: string;
  kind: string;
  due: string;
  state: PieceState;
  ledger: number;
  registry: boolean;
  /** Seconds from its time to the ledger's first entry */
  delaySeconds: number | null;
  why?: string;
}

export interface ScaleSummary {
  run: string;
  checkedAt: string;
  window: { start: string; end: string };
  verdict: 'pass' | 'fail' | 'incomplete';
  counts: Record<PieceState, number> & { pieces: number; late: number };
  /** The network's posts the registry does not know of, and the registry's preview posts the network never got, whatever launch */
  orphans: { ledgerOnly: number; registryOnly: number; examples: string[] };
  exercise: Record<string, { total: number; failed: number; p50Ms: number | null; p95Ms: number | null }>;
  settings: { saves: number; staleReads: number };
  oauth: { started: number; callbacks: number; failedCallbacks: number };
  secrets: { written: number; lost: number; examples: string[] };
  /** Failed requests of any kind: the rolling deploy's check reads this */
  failedRequests: number;
  /** Requests no replica answered, when they are counted apart (ignoreUnreachable) */
  unreachable: number;
  delays: { p50Seconds: number | null; p95Seconds: number | null; maxSeconds: number | null };
  pieces: PieceResult[];
  /** Why the verdict is not a pass, one line each */
  problems: string[];
}

const LIVE = new Set(['live', 'edited']);

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

/** Compares the plan, the registry and the ledger piece by piece, and the exercise's requests, into a verdict */
export function checkScale(input: CheckInput): ScaleSummary {
  const grace = input.graceMs ?? 10 * 60_000;
  const lateMs = input.lateMs ?? 5 * 60_000;
  const published = input.ledger.filter((e) => e.action === 'publish');
  const pieces: PieceResult[] = [];
  for (const launch of input.plan.launches) {
    for (const [channel, due] of Object.entries(launch.times) as Array<[Channel, string]>) {
      for (const kind of expectedKinds(channel)) {
        const sent = published.filter((e) => e.marker === launch.marker && e.channel === channel && e.kind === kind);
        const row = input.registry.find((r) => r.launchId === launch.launchId && r.channel === channel && r.kind === kind && LIVE.has(r.status));
        const held = input.unknown.some((u) => u.launchId === launch.launchId && u.channel === channel && (u.kind === kind || u.kind === 'post'));
        const first = sent.map((e) => Date.parse(e.at)).sort((a, b) => a - b)[0];
        const base = { launch: launch.index, launchId: launch.launchId, channel, kind, due, ledger: sent.length, registry: row !== undefined, delaySeconds: first === undefined ? null : Math.round((first - Date.parse(due)) / 1000) };
        let state: PieceState;
        let why: string | undefined;
        if (sent.length > 1) [state, why] = ['duplicate', `the network got it ${sent.length} times`];
        else if (row && sent.length === 1 && row.externalId !== sent[0]!.externalId) [state, why] = ['mismatch', `the registry says ${row.externalId}, the network ${sent[0]!.externalId}`];
        else if (row && sent.length === 0) [state, why] = ['mismatch', 'the registry says it is out; the network never got it'];
        else if (row) state = 'ok';
        else if (held) [state, why] = ['unknown', sent.length === 1 ? 'a worker stopped mid-send; the network has it, the registry does not: the owner must not Try again' : 'a worker stopped mid-send; the network does not have it: Try again sends it once'];
        else if (sent.length === 1) [state, why] = ['mismatch', 'the network has it; the registry does not'];
        else if (Date.parse(due) + grace < input.now.getTime()) [state, why] = ['missed', `not out ${Math.round((input.now.getTime() - Date.parse(due)) / 60_000)} minutes after its time`];
        else state = 'pending';
        pieces.push({ ...base, state, ...(why && { why }) });
      }
    }
  }

  // Beyond the plan (pieces the plan's check already counted are left out): every post the preview
  // made, against every row that says it went out on a fake network
  const planned = new Set(input.plan.launches.map((l) => l.marker));
  const plannedIds = new Set(input.plan.launches.map((l) => l.launchId));
  const registryIds = new Set(input.registry.map((r) => r.externalId).filter((id): id is string => id !== null));
  const ledgerIds = new Set(published.map((e) => e.externalId).filter((id): id is string => id !== null));
  const ledgerOrphans = published.filter((e) => e.externalId !== null && !registryIds.has(e.externalId) && !(e.marker !== null && planned.has(e.marker)));
  const registryOnly = input.registry.filter((r) => r.externalId !== null && r.externalId.startsWith('preview-') && LIVE.has(r.status) && !ledgerIds.has(r.externalId) && !plannedIds.has(r.launchId));

  const groups: ScaleSummary['exercise'] = {};
  for (const kind of [...new Set(input.exercise.map((e) => e.kind))].sort()) {
    const events = input.exercise.filter((e) => e.kind === kind);
    groups[kind] = { total: events.length, failed: events.filter((e) => !e.ok).length, p50Ms: percentile(events.map((e) => e.ms), 50), p95Ms: percentile(events.map((e) => e.ms), 95) };
  }
  const exercised = input.ignoreUnreachable ? input.exercise.filter((e) => e.ok || e.status !== 0 || e.kind === 'secret') : input.exercise;
  const reads = exercised.filter((e) => e.kind === 'settings-read');
  const callbacks = exercised.filter((e) => e.kind === 'oauth-callback');
  const lost = input.secrets.filter((s) => !s.secretFound);
  const delays = pieces.map((p) => p.delaySeconds).filter((d): d is number => d !== null);

  const counts = { ok: 0, duplicate: 0, mismatch: 0, missed: 0, unknown: 0, pending: 0, pieces: pieces.length, late: delays.filter((d) => d * 1000 > lateMs).length };
  for (const p of pieces) counts[p.state] += 1;
  const unreachable = input.ignoreUnreachable ? input.exercise.filter((e) => !e.ok && e.status === 0 && e.kind !== 'secret').length : 0;
  const failedRequests = exercised.filter((e) => !e.ok && e.kind !== 'settings-read' && e.kind !== 'secret' && e.kind !== 'oauth-callback').length;
  const staleReads = reads.filter((e) => !e.ok).length;

  const problems: string[] = [];
  if (counts.duplicate) problems.push(`${counts.duplicate} pieces went out more than once`);
  if (counts.missed) problems.push(`${counts.missed} pieces missed their time`);
  if (counts.mismatch) problems.push(`${counts.mismatch} pieces differ between the registry and the network`);
  if (counts.unknown) problems.push(`${counts.unknown} pieces were left unknown by a stopped worker`);
  if (ledgerOrphans.length) problems.push(`${ledgerOrphans.length} posts on the fake networks the registry does not know of`);
  if (registryOnly.length) problems.push(`${registryOnly.length} preview posts in the registry the fake networks never got`);
  if (lost.length) problems.push(`${lost.length} secret writes were lost`);
  if (callbacks.some((e) => !e.ok)) problems.push(`${callbacks.filter((e) => !e.ok).length} OAuth callbacks failed`);
  if (failedRequests) problems.push(`${failedRequests} requests failed`);
  if (staleReads) problems.push(`${staleReads} settings reads on another replica did not see the save`);
  const verdict = problems.length > 0 ? 'fail' : counts.pending > 0 ? 'incomplete' : 'pass';

  return {
    run: input.plan.run,
    checkedAt: input.now.toISOString(),
    window: { start: input.plan.start, end: input.plan.end },
    verdict,
    counts,
    orphans: { ledgerOnly: ledgerOrphans.length, registryOnly: registryOnly.length, examples: [...ledgerOrphans.map((e) => `network only: ${e.channel} ${e.kind} ${e.externalId}`), ...registryOnly.map((r) => `registry only: launch ${r.launchId} ${r.channel} ${r.kind} ${r.externalId}`)].slice(0, 20) },
    exercise: groups,
    settings: { saves: input.exercise.filter((e) => e.kind === 'settings-save').length, staleReads },
    oauth: { started: input.exercise.filter((e) => e.kind === 'oauth-start').length, callbacks: callbacks.length, failedCallbacks: callbacks.filter((e) => !e.ok).length },
    secrets: { written: input.secrets.length, lost: lost.length, examples: lost.slice(0, 10).map((s) => s.label) },
    failedRequests,
    unreachable,
    delays: { p50Seconds: percentile(delays, 50), p95Seconds: percentile(delays, 95), maxSeconds: delays.length ? Math.max(...delays) : null },
    pieces,
    problems,
  };
}

/** The summary as Markdown, for the report */
export function scaleMarkdown(summary: ScaleSummary, kpis?: string): string {
  const c = summary.counts;
  const lines = [
    `# Scale test ${summary.run}: ${summary.verdict.toUpperCase()}`,
    '',
    `Checked ${summary.checkedAt}; pieces due ${summary.window.start} to ${summary.window.end}.`,
    '',
    '| Check | Result |',
    '| --- | --- |',
    `| Pieces planned | ${c.pieces} |`,
    `| Out exactly once, registry and network agreeing | ${c.ok} |`,
    `| Duplicates | ${c.duplicate} |`,
    `| Missed schedules | ${c.missed} |`,
    `| Registry vs network mismatches | ${c.mismatch} (and ${summary.orphans.ledgerOnly} network-only, ${summary.orphans.registryOnly} registry-only posts outside the plan) |`,
    `| Left unknown by a stopped worker | ${c.unknown} |`,
    `| Still pending | ${c.pending} |`,
    `| Late (over 5 min) | ${c.late}; delay p50 ${summary.delays.p50Seconds ?? '–'} s, p95 ${summary.delays.p95Seconds ?? '–'} s, max ${summary.delays.maxSeconds ?? '–'} s |`,
    `| Settings saves / stale reads on another replica | ${summary.settings.saves} / ${summary.settings.staleReads} |`,
    `| OAuth round trips / failed callbacks | ${summary.oauth.callbacks} / ${summary.oauth.failedCallbacks} |`,
    `| Secret writes / lost | ${summary.secrets.written} / ${summary.secrets.lost} |`,
    `| Failed requests | ${summary.failedRequests}${summary.unreachable ? ` (and ${summary.unreachable} to a replica that was stopping, counted apart)` : ''} |`,
    '',
  ];
  if (summary.problems.length > 0) lines.push('## Problems', '', ...summary.problems.map((p) => `- ${p}`), '');
  const bad = summary.pieces.filter((p) => p.state !== 'ok' && p.state !== 'pending');
  if (bad.length > 0) {
    lines.push('## Pieces that are not right', '', '| Launch | Channel | Kind | Due | State | Why |', '| --- | --- | --- | --- | --- | --- |');
    for (const p of bad.slice(0, 100)) lines.push(`| ${p.launch} (#${p.launchId ?? '?'}) | ${p.channel} | ${p.kind} | ${p.due} | ${p.state} | ${p.why ?? ''} |`);
    lines.push('');
  }
  if (summary.orphans.examples.length > 0) lines.push('## Posts outside the plan that do not match', '', ...summary.orphans.examples.map((e) => `- ${e}`), '');
  lines.push('## Requests', '', '| Kind | Total | Failed | p50 ms | p95 ms |', '| --- | --- | --- | --- | --- |');
  for (const [kind, g] of Object.entries(summary.exercise)) lines.push(`| ${kind} | ${g.total} | ${g.failed} | ${g.p50Ms ?? '–'} | ${g.p95Ms ?? '–'} |`);
  lines.push('');
  if (kpis) lines.push('## KPIs over the window (scripts/measure.ts)', '', kpis, '');
  return lines.join('\n');
}
