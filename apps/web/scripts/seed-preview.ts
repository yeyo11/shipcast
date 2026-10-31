import { resolve } from 'node:path';
import {
  AppReviewService,
  connectRepositories,
  DEFAULT_AI_SETTINGS,
  draftOfPiece,
  failureKey,
  LaunchStoreService,
  renderDrafts,
  unavailableMediaStore,
  saveTimezone,
  SettingsService,
  writeAiSettings,
  type Account,
  type AppReviewGitHub,
  type DraftFile,
  type Launch,
  type LaunchStatus,
  type OpenRepositories,
  type Post,
  type PostKind,
  type ReviewGitHub,
  type Trigger,
} from '@shipcast/engine';
import {
  accountSecretKey,
  connectAccount,
  loadConfig,
  poolOptions,
  previewDatabase,
  previewFixtures,
  RuntimeSettings,
  QUEUE_SCHEMA,
  scheduleRound,
  secretStoreFor,
  WorkQueue,
  writeAutomation,
  type JobQueue,
  type SecretStore,
} from '@shipcast/runtime';
import { ContentPack, formatIssues, parseBrand, parseLaunchConfig, type Brand, type Channel, type LaunchConfig, type PackKind } from '@shipcast/schema';
import { BRAND_YML, claudioPack, launchYml, pandoPack, SITE } from './seed-preview-content.ts';
import { answerTour, complete, finish, initialState, ONBOARDING_KEY, STEPS, type OnboardingState } from '../src/server/onboarding.ts';

/**
 * Seeds a preview's throwaway database with the data set of the redesign's design board, so every
 * screen can be looked at (and screenshotted) against it: the owner's brand set up, its accounts
 * connected (LinkedIn's expired), five launches in each state the Launches page tells apart, their
 * pieces, numbers and comments.
 *
 *   node apps/web/scripts/seed-preview.ts            the full data set
 *   node apps/web/scripts/seed-preview.ts --empty    a finished onboarding and nothing else (empty states)
 *
 * It refuses any database whose name does not end in `_preview` (the preview guard's own test), and
 * every run wipes what it seeds first and restarts the tables' ids, so running it twice ends in the
 * same rows with the same ids. Credentials are made-up strings in the preview's secret store; nothing
 * here reaches a network. The running app reads the settings again at its next round, which this
 * script queues (automation is off, so the round only re-reads the settings and stops).
 *
 * pando v1.0.0 and claudio v1.5.0 are launches Shipcast holds (the launch model, docs/app-review.md):
 * their content packs go through the pipeline's own delivery (renderDrafts, then AppReviewService.hold),
 * so the review, content and preview screens show real drafts when the app runs with
 * SHIPCAST_FLAGS=launch-store,launch-store-read,launch-media,app-review. With SHIPCAST_PREVIEW_FIXTURES
 * set, it also writes the files the app reads from GitHub there: the brand.yml, each repo's
 * .github/launch.yml and each held launch's drafts on the launches repo.
 *
 * What it cannot seed, and why, is in the notes at the end of the file.
 */

const ROOT = resolve(import.meta.dirname, '../../..');
const EMPTY = process.argv.includes('--empty');

const url = process.env.SHIPCAST_DATABASE_URL?.trim();
if (!url) fail('SHIPCAST_DATABASE_URL is not set');
if (!previewDatabase(url)) fail('refusing to run: SHIPCAST_DATABASE_URL does not name a preview database (its name must end in _preview)');

function fail(message: string): never {
  console.error(`seed-preview: ${message}`);
  process.exit(2);
}

// ---- the owner and the brand ----

const OWNER = 'yeyo11';
const LAUNCHES_REPO = 'yeyo11/launches';
const TIMEZONE = 'Europe/Madrid';
/** The brand's id as the launches repo's brand.yml says it, which the app reads; josegarridodev on the networks */
const BRAND_ID = 'personal';
/** The channels each repo's launch.yml publishes on, with approval */
const REPO_CHANNELS: Record<string, { channels: Channel[]; pack: 'launch' | 'major' | 'minor' }> = {
  pando: { channels: ['blog', 'bluesky', 'linkedin', 'mastodon'], pack: 'launch' },
  claudio: { channels: ['blog', 'bluesky', 'mastodon', 'devto', 'linkedin', 'telegram'], pack: 'minor' },
  sluice: { channels: ['blog', 'bluesky', 'mastodon'], pack: 'major' },
  shipcast: { channels: ['blog', 'bluesky', 'mastodon', 'devto'], pack: 'minor' },
};

/** Every table this script writes, children first; the queue's own (pg-boss) and the telemetry are left alone */
const TABLES = [
  'comments',
  'metric_days',
  'metrics',
  'publish_attempts',
  'approvals',
  'draft_versions',
  'drafts',
  'packs',
  'media',
  'launch_channels',
  'launch_sources',
  'draft_snapshots',
  'assistant_messages',
  'assistant_sessions',
  'jobs',
  'posts',
  'account_snapshots',
  'accounts',
  'launch_imports',
  'launch_deletions',
  'launches',
  'attention_dismissals',
  'cursors',
  'settings',
];

// ---- time ----

const NOW = new Date();
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);
const hoursAgo = (n: number) => minutesAgo(n * 60);

/** A wall-clock time in the owner's zone as an instant: `madrid('2026-10-20', '12:00')` */
function madrid(day: string, time: string): Date {
  const asUtc = new Date(`${day}T${time}:00.000Z`);
  const offset = new Intl.DateTimeFormat('en', { timeZone: TIMEZONE, timeZoneName: 'longOffset' }).formatToParts(asUtc).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(offset);
  const minutes = match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
  return new Date(asUtc.getTime() - minutes * 60_000);
}

/** The next 10:00 in Madrid that is still ahead: Telegram's scheduled piece never falls due while seeding */
function nextMorning(): Date {
  for (let d = 0; d < 3; d++) {
    const day = new Date(NOW.getTime() + d * 86_400_000).toISOString().slice(0, 10);
    const at = madrid(day, '10:00');
    if (at.getTime() > NOW.getTime() + 30 * 60_000) return at;
  }
  return new Date(NOW.getTime() + 86_400_000);
}

/** The days from `from` to today, YYYY-MM-DD */
function daysSince(from: string): string[] {
  const out: string[] = [];
  const today = NOW.toISOString().slice(0, 10);
  for (let t = Date.parse(`${from}T00:00:00.000Z`); ; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (day > today) break;
    out.push(day);
  }
  return out;
}

/** When a day's reading was taken: its evening, or a little before now for today */
function readingAt(day: string): Date {
  const evening = new Date(`${day}T22:00:00.000Z`);
  return evening.getTime() < NOW.getTime() ? evening : minutesAgo(20);
}

// ---- raw SQL, where no repository writes the column (timestamps the services set to now) ----

const quote = (value: string | null) => (value === null ? 'NULL' : `'${value.replace(/'/g, "''")}'`);

async function exec(registry: OpenRepositories, statement: string): Promise<void> {
  await registry.database.execute(statement);
}

const iso = (d: Date) => d.toISOString();

// ---- wipe ----

async function wipe(registry: OpenRepositories, secrets: SecretStore): Promise<void> {
  // The accounts' credentials first: their keys are named by the ids the truncation restarts
  for (const account of await registry.accounts.accounts()) await secrets.delete(accountSecretKey(account.id));
  await exec(registry, `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  // The launch work still waiting in pg-boss names launches that are gone now (the parked draft below among them)
  await exec(registry, `DELETE FROM ${QUEUE_SCHEMA}.job WHERE name IN ('draft', 'article', 'publish') AND state IN ('created', 'retry')`);
}

// ---- settings and onboarding ----

async function seedSettings(registry: OpenRepositories, secrets: SecretStore): Promise<void> {
  // Automation first: with it off, none of the app's timed work (rounds, metrics, comments) touches the seeded rows
  await writeAutomation(registry, { mode: 'off', intervalSeconds: 300 });
  await new RuntimeSettings({ registry, secrets, env: {} }).write({
    launchesRepo: LAUNCHES_REPO,
    // claudio for every task, at an address that answers nothing: a preview never drafts for real
    claudioUrl: 'https://claudio.preview.invalid',
    claudioToken: 'preview-fake-claudio-token',
  });
  await writeAiSettings(registry, DEFAULT_AI_SETTINGS);
  await saveTimezone(registry, TIMEZONE);
  await new SettingsService(registry).save(ONBOARDING_KEY, finishedOnboarding());
}

/**
 * The onboarding as the app leaves it once the owner went through it: every step done, finished, the
 * tour declined. The shell only reads the stored row (getOnboardingState), so this is all that keeps
 * the app on Launches instead of the onboarding; what the steps detect (brand.yml read from GitHub,
 * claudio's settings, a channel account) is seeded too, so opening the onboarding from Settings agrees.
 */
function finishedOnboarding(): OnboardingState {
  const created = hoursAgo(24 * 20);
  let state = initialState({ brand: false, ai: false, channels: false, measure: false, automation: false }, { hasLaunches: false }, created);
  for (const step of STEPS) state = complete(state, step);
  return answerTour(finish(state, new Date(created.getTime() + 15 * 60_000)), 'declined');
}

// ---- accounts ----

interface AccountSeed {
  network: string;
  label: string;
  settings: Record<string, string>;
  secrets: Record<string, string>;
  /** The handle the network's check answers with, shown as the account's identity */
  identity: string;
  /** Set for an account whose last check failed */
  problem?: string;
  followers?: { from: number; to: number; following?: number; posts?: number };
}

const ACCOUNTS: AccountSeed[] = [
  { network: 'bluesky', label: '@josegarrido.dev', settings: { handle: 'josegarrido.dev' }, secrets: { appPassword: 'preview-fake-app-password' }, identity: '@josegarrido.dev', followers: { from: 1180, to: 1262, following: 310, posts: 842 } },
  { network: 'mastodon', label: '@yeyo11@mastodon.social', settings: { instance: 'https://mastodon.social' }, secrets: { accessToken: 'preview-fake-mastodon-token' }, identity: '@yeyo11@mastodon.social', followers: { from: 402, to: 431, following: 188, posts: 615 } },
  { network: 'linkedin', label: 'José Antonio Garrido', settings: { preview: 'true' }, secrets: { accessToken: 'preview-fake-linkedin-token' }, identity: 'José Antonio Garrido', problem: 'The token expired on 28 Oct: sign in to LinkedIn again', followers: { from: 2310, to: 2318 } },
  { network: 'devto', label: 'yeyo11', settings: {}, secrets: { apiKey: 'preview-fake-devto-key' }, identity: 'yeyo11', followers: { from: 268, to: 281, posts: 34 } },
  { network: 'telegram', label: '@josegarridodev', settings: { chatId: '@josegarridodev' }, secrets: { botToken: 'preview-fake-telegram-bot-token' }, identity: '@josegarridodev', followers: { from: 140, to: 149 } },
  { network: 'threads', label: '@josegarridodev', settings: { preview: 'true' }, secrets: { accessToken: 'preview-fake-threads-token' }, identity: '@josegarridodev', followers: { from: 512, to: 538, following: 95, posts: 120 } },
];

async function seedAccounts(registry: OpenRepositories, secrets: SecretStore, brand: Brand): Promise<Map<string, Account>> {
  const out = new Map<string, Account>();
  for (const seed of ACCOUNTS) {
    // Connected as the Channels page connects them, with the network's check answered here instead of asked
    const connected = await connectAccount(
      { registry, secrets, brands: new Map([[brand.id, brand]]), check: async () => ({ ok: true, account: seed.identity }) },
      { network: seed.network, brand: brand.id, label: seed.label, credentials: { settings: seed.settings, secrets: seed.secrets } },
    );
    if (!connected.ok) fail(`connecting ${seed.network}: ${connected.problem}`);
    let account = connected.account;
    if (seed.followers) {
      // Two weeks of daily numbers, so the week's change and the growth lines have something to draw
      const days = 14;
      for (let d = days; d >= 0; d--) {
        const at = d === 0 ? minutesAgo(40) : new Date(NOW.getTime() - d * 86_400_000);
        const share = (days - d) / days;
        const { from, to, following, posts } = seed.followers;
        await registry.accounts.recordSnapshot(account.id, { followers: Math.round(from + (to - from) * share), ...(following !== undefined && { following }), ...(posts !== undefined && { posts: posts - Math.round(d / 3) }) }, at);
      }
    }
    if (seed.problem) account = await registry.accounts.recordCheck(account.id, { ok: false, problem: seed.problem }, hoursAgo(26));
    else account = await registry.accounts.recordCheck(account.id, { ok: true, account: seed.identity }, minutesAgo(40));
    out.set(seed.network, account);
  }
  return out;
}

// ---- launches ----

interface LaunchSeed {
  repo: string;
  ref: string;
  trigger: Trigger;
  kind: PackKind;
  status: LaunchStatus;
  title?: string;
  detail?: string;
  createdAt: Date;
  updatedAt: Date;
}

async function seedLaunch(registry: OpenRepositories, seed: LaunchSeed): Promise<Launch> {
  const { launch } = await registry.launches.claim({ repo: seed.repo, ref: seed.ref, trigger: seed.trigger, kind: seed.kind, brand: BRAND_ID, ...(seed.title && { title: seed.title }) });
  if (seed.status !== 'detected') await registry.launches.setStatus(launch.id, seed.status, seed.detail ?? null);
  await exec(registry, `UPDATE launches SET created_at = ${quote(iso(seed.createdAt))}, updated_at = ${quote(iso(seed.updatedAt))} WHERE id = ${launch.id}`);
  return (await registry.launches.get(launch.id))!;
}

interface PieceSeed {
  channel: Channel;
  kind?: PostKind;
  account?: Account | undefined;
  url: string;
  externalId: string;
  publishedAt: Date;
}

async function seedPiece(registry: OpenRepositories, launch: Launch, seed: PieceSeed): Promise<Post> {
  const { post } = await registry.posts.recordPost({ launchId: launch.id, channel: seed.channel, kind: seed.kind ?? 'post', accountId: seed.account?.id ?? null, externalId: seed.externalId, url: seed.url, status: 'live' });
  await exec(registry, `UPDATE posts SET published_at = ${quote(iso(seed.publishedAt))}, updated_at = ${quote(iso(seed.publishedAt))} WHERE id = ${post.id}`);
  return post;
}

/**
 * A piece's counters read once a day since it went out, each day's reading the running total, as
 * the metrics job leaves them; `daily` is what each day added, so the views-per-day lines draw it back.
 */
async function seedReadings(registry: OpenRepositories, launch: Launch, post: Post, source: string, from: string, totals: Record<string, number>, daily?: Record<string, number[]>): Promise<void> {
  const days = daysSince(from);
  const sums: Record<string, number> = {};
  for (const [i, day] of days.entries()) {
    const values: Record<string, number> = {};
    for (const [name, total] of Object.entries(totals)) {
      const curve = daily?.[name];
      // Without a curve, most of a counter arrives in the first days, as a post's numbers do
      const added = curve ? (curve[i] ?? 0) : Math.round(total * (i === 0 ? 0.55 : i === 1 ? 0.25 : i === 2 ? 0.1 : i < days.length - 1 ? 0.1 / Math.max(1, days.length - 4) : 0));
      sums[name] = Math.min(total, (sums[name] ?? 0) + added);
      values[name] = i === days.length - 1 ? total : sums[name]!;
    }
    await registry.metrics.recordMetrics(launch.id, source, values, readingAt(day), post.id);
  }
}

/** The blog's numbers: site-wide, kept per day as the analytics count them, and as running totals */
async function seedBlog(registry: OpenRepositories, launch: Launch, from: string, views: number[], visitsShare: number): Promise<void> {
  const days = daysSince(from);
  const perDay: Record<string, Record<string, number>> = {};
  let totalViews = 0;
  let totalVisits = 0;
  for (const [i, day] of days.entries()) {
    const v = views[i] ?? 0;
    const visits = Math.round(v * visitsShare);
    perDay[day] = { views: v, visits };
    totalViews += v;
    totalVisits += visits;
    await registry.metrics.recordMetrics(launch.id, 'blog', { views: totalViews, visits: totalVisits }, readingAt(day));
  }
  await registry.metrics.recordDays(launch.id, 'blog', perDay, minutesAgo(20));
}

interface CommentSeed {
  post: Post;
  channel: Channel;
  id: string;
  handle: string;
  name: string;
  text: string;
  at: Date;
  status: 'draft-ready' | 'sent' | 'dismissed';
  classification: 'question' | 'feedback' | 'praise' | 'bug' | 'spam';
  draft?: string;
  note?: string;
  sentAt?: Date;
}

async function seedComment(registry: OpenRepositories, seed: CommentSeed): Promise<void> {
  const { comment } = await registry.comments.recordComment({
    postId: seed.post.id,
    channel: seed.channel,
    externalId: seed.id,
    author: { handle: seed.handle, displayName: seed.name },
    text: seed.text,
    url: `${seed.post.url ?? SITE}#${seed.id}`,
    createdAt: iso(seed.at),
    own: false,
  });
  await registry.comments.updateComment(comment.id, {
    status: seed.status,
    classification: seed.classification,
    draft: seed.draft ?? null,
    note: seed.note ?? null,
    ...(seed.status === 'sent' && { sentExternalId: `${seed.id}-reply`, sentUrl: `${seed.post.url ?? SITE}#${seed.id}-reply`, sentAt: iso(seed.sentAt ?? new Date(seed.at.getTime() + 3 * 3_600_000)) }),
  });
  const fetched = new Date(seed.at.getTime() + 10 * 60_000);
  await exec(registry, `UPDATE comments SET fetched_at = ${quote(iso(fetched))}, updated_at = ${quote(iso(seed.sentAt ?? fetched))} WHERE id = ${comment.id}`);
}

/** A job that ended, as the queue's mirror shows it; not in pg-boss itself, so the app's queue never runs it */
async function seedJob(registry: OpenRepositories, n: number, job: { queue: string; title: string; launch: Launch; state: 'completed' | 'failed'; log: string[]; startedAt: Date; endedAt: Date }): Promise<void> {
  // A fixed UUID per job, as pg-boss's ids are; ended, so no reconciliation looks for it
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  await registry.jobs.recordJob({ id, queue: job.queue, title: job.title, launchId: job.launch.id });
  await registry.jobs.updateJob(id, { state: job.state, attempts: 1, link: `/launches/${job.launch.id}`, started: true, ended: true });
  for (const line of job.log) await registry.jobs.logJob(id, line);
  await exec(
    registry,
    `UPDATE jobs SET created_at = ${quote(iso(job.startedAt))}, started_at = ${quote(iso(job.startedAt))}, ended_at = ${quote(iso(job.endedAt))} WHERE id = ${quote(id)}`,
  );
}

/**
 * The draft of a launch "being drafted": a real draft job, so the app's reconciliation (at every start
 * of its queue, which a dev server's program reload is) finds it held and leaves the launch generating
 * instead of failing it as interrupted. It is parked 13 days ahead (inside pg-boss's 14-day retention)
 * so the app never runs it while the preview is looked at; the next seed deletes it.
 */
async function parkDraft(registry: OpenRepositories, queue: JobQueue, launch: Launch): Promise<void> {
  const id = await queue.send('draft', { launchId: launch.id }, { title: `Drafting ${launch.repo} ${launch.ref}`, launchId: launch.id, startAfter: 13 * 86_400 });
  if (!id) fail(`the draft of ${launch.repo} ${launch.ref} was not queued`);
  await registry.jobs.updateJob(id, { state: 'active', attempts: 1, started: true });
  await registry.jobs.logJob(id, 'Reading the code and writing the pack; this takes a few minutes…');
  await exec(registry, `UPDATE jobs SET created_at = ${quote(iso(minutesAgo(2)))}, started_at = ${quote(iso(minutesAgo(2)))} WHERE id = ${quote(id)}`);
}

/** GitHub as the delivery of a held launch sees it: never called there, so every call is refused */
const refuse = (what: string) => (): Promise<never> => Promise.reject(new Error(`the preview seed reaches no GitHub (${what})`));
const NO_GITHUB: ReviewGitHub & AppReviewGitHub = {
  pullRequest: refuse('pullRequest'),
  pullRequestFiles: refuse('pullRequestFiles'),
  fileAt: refuse('fileAt'),
  updateFile: refuse('updateFile'),
  mergePullRequest: refuse('mergePullRequest'),
  pushPreview: refuse('pushPreview'),
  pullRequestComments: refuse('pullRequestComments'),
  closePreview: refuse('closePreview'),
  commitToBranch: refuse('commitToBranch'),
};

/** A repo's launch.yml, parsed: the seed's own text, so a mistake in it stops the seed */
function configOf(repo: string): { text: string; config: LaunchConfig } {
  const name = repo.split('/')[1] ?? repo;
  const spec = REPO_CHANNELS[name];
  if (!spec) fail(`no launch.yml for ${repo}`);
  const text = launchYml(spec.channels, spec.pack);
  const parsed = parseLaunchConfig(text);
  if (!parsed.ok) fail(formatIssues(`${repo} launch.yml`, parsed.issues));
  return { text, config: parsed.value };
}

/** The drafts of each held launch, as renderDrafts laid them out, for the fixtures */
const heldFiles: DraftFile[] = [];

/**
 * A launch Shipcast holds, delivered as the pipeline delivers one under app-review: the pack's drafts
 * rendered (renderDrafts, as the drafts pull request would carry them), then AppReviewService.hold,
 * which writes the pack, the channels and a version of each draft, and makes the launch an `app` one.
 * Approved when `approvedAt` is given. The launch keeps the status and times it was seeded with.
 */
async function hold(registry: OpenRepositories, launch: Launch, pack: ContentPack, brand: Brand, draftedAt: Date, options: { approvedAt?: Date } = {}): Promise<void> {
  const checked = ContentPack.safeParse(pack);
  if (!checked.success) fail(`${launch.repo} ${launch.ref}: the pack does not validate: ${checked.error.message}`);
  const { text, config } = configOf(launch.repo);
  const files = renderDrafts(checked.data, launch, config, brand, draftedAt).filter((f) => 'content' in f);
  heldFiles.push(...files);
  const media = unavailableMediaStore('a preview seed stores no media');
  const store = new LaunchStoreService({ registry, media, github: NO_GITHUB, launchesRepo: LAUNCHES_REPO });
  const review = new AppReviewService({ registry, media, github: NO_GITHUB, launchesRepo: LAUNCHES_REPO, store });
  const held = await review.hold(launch, { pack: checked.data, configText: text, files });
  if (options.approvedAt) await review.approve(held, OWNER);
  // hold() leaves the launch drafted now: back to the state and times it was seeded with
  await registry.launches.setStatus(launch.id, launch.status, launch.detail);
  await exec(registry, `UPDATE launches SET created_at = ${quote(launch.createdAt)}, updated_at = ${quote(launch.updatedAt)} WHERE id = ${launch.id}`);
  const at = quote(iso(draftedAt));
  await exec(registry, `UPDATE packs SET created_at = ${at} WHERE launch_id = ${launch.id}`);
  await exec(registry, `UPDATE drafts SET created_at = ${at}, updated_at = ${at} WHERE launch_id = ${launch.id}`);
  await exec(registry, `UPDATE draft_versions SET created_at = ${at} WHERE draft_id IN (SELECT id FROM drafts WHERE launch_id = ${launch.id})`);
  await exec(registry, `UPDATE launch_channels SET updated_at = ${at} WHERE launch_id = ${launch.id}`);
  if (options.approvedAt) await exec(registry, `UPDATE approvals SET at = ${quote(iso(options.approvedAt))} WHERE launch_id = ${launch.id}`);
}

/** Each live piece of a held launch names the draft version it published, as publishing records it */
async function linkPieces(registry: OpenRepositories, launch: Launch): Promise<void> {
  const drafts = await registry.launchStore.drafts(launch.id);
  for (const post of await registry.posts.posts(launch.id)) {
    if (post.status === 'scheduled') continue;
    const piece = draftOfPiece(post.channel, post.kind, drafts);
    const draft = drafts.find((d) => d.channel === post.channel && d.piece === piece);
    if (draft) await registry.launchStore.linkPost(post.id, draft.versionId);
  }
}

/**
 * What the app reads from GitHub, in the preview's fixtures (SHIPCAST_PREVIEW_FIXTURES, layout in
 * packages/runtime/src/preview/fixtures.ts): the brand.yml, each seeded repo's launch.yml and the held
 * launches' drafts where the launches repo would keep them. Anything else the app asks GitHub for is
 * not there, and the preview's dummy token makes GitHub refuse it.
 */
function writeFixtures(): string | undefined {
  const fixtures = previewFixtures(process.env);
  if (!fixtures) return undefined;
  fixtures.writeGitHub(LAUNCHES_REPO, 'brand.yml', BRAND_YML);
  for (const name of Object.keys(REPO_CHANNELS)) fixtures.writeGitHub(`${OWNER}/${name}`, '.github/launch.yml', configOf(`${OWNER}/${name}`).text);
  for (const file of heldFiles) if ('content' in file) fixtures.writeGitHub(LAUNCHES_REPO, file.path, file.content);
  return fixtures.root;
}

const postUrl = {
  blog: (slug: string) => `${SITE}/en/${slug}/`,
  bluesky: (rkey: string) => `https://bsky.app/profile/josegarrido.dev/post/${rkey}`,
  mastodon: (id: string) => `https://mastodon.social/@yeyo11/${id}`,
  devto: (slug: string) => `https://dev.to/yeyo11/${slug}`,
  telegram: (id: string) => `https://t.me/josegarridodev/${id}`,
};

async function seedLaunches(registry: OpenRepositories, queue: JobQueue, accounts: Map<string, Account>, brand: Brand): Promise<Record<string, number>> {
  const ids: Record<string, number> = {};

  // 1. An article, published 14 Oct on the blog, Bluesky and Mastodon
  const articleAt = madrid('2026-10-14', '09:30');
  const article = await seedLaunch(registry, {
    repo: LAUNCHES_REPO,
    ref: 'article:why-i-moved-my-notes-into-the-repo',
    trigger: 'article',
    kind: 'launch',
    status: 'published',
    title: 'Why I moved my notes into the repo',
    createdAt: new Date(articleAt.getTime() - 40 * 60_000),
    updatedAt: new Date(articleAt.getTime() + 10 * 60_000),
  });
  ids.article = article.id;
  await seedPiece(registry, article, { channel: 'blog', kind: 'article:en', url: postUrl.blog('why-i-moved-my-notes-into-the-repo'), externalId: 'src/content/posts/en/why-i-moved-my-notes-into-the-repo.md', publishedAt: articleAt });
  const articleBsky = await seedPiece(registry, article, { channel: 'bluesky', account: accounts.get('bluesky'), url: postUrl.bluesky('3l6notesrepo2a'), externalId: 'at://did:plc:previewjosegarrido/app.bsky.feed.post/3l6notesrepo2a', publishedAt: new Date(articleAt.getTime() + 2 * 60_000) });
  const articleMasto = await seedPiece(registry, article, { channel: 'mastodon', account: accounts.get('mastodon'), url: postUrl.mastodon('113350000000000001'), externalId: '113350000000000001', publishedAt: new Date(articleAt.getTime() + 5 * 60_000) });
  // 2,140 views, 96 reactions, 18 comments
  await seedBlog(registry, article, '2026-10-14', [520, 610, 340, 210, 140, 95, 70, 50, 35, 25, 15, 10, 8, 5, 4, 3, 0, 0], 0.62);
  await seedReadings(registry, article, articleBsky, 'bluesky', '2026-10-14', { likes: 61, replies: 11, reposts: 14, quotes: 3 });
  await seedReadings(registry, article, articleMasto, 'mastodon', '2026-10-14', { favourites: 35, replies: 7, boosts: 9 });

  // 2. claudio v1.5.0, published 20 Oct: LinkedIn failed (the token expired), Telegram scheduled
  const claudioAt = madrid('2026-10-20', '12:00');
  const claudio = await seedLaunch(registry, {
    repo: 'yeyo11/claudio',
    ref: 'v1.5.0',
    trigger: 'release',
    kind: 'minor',
    status: 'published',
    createdAt: new Date(claudioAt.getTime() - 2 * 3_600_000),
    updatedAt: new Date(claudioAt.getTime() + 15 * 60_000),
  });
  ids.claudio = claudio.id;
  // Its drafts as Shipcast held them, approved, then published: the pieces below name the versions that went out
  await hold(registry, claudio, claudioPack(), brand, claudioAt, { approvedAt: new Date(claudioAt.getTime() - 30 * 60_000) });
  await seedPiece(registry, claudio, { channel: 'blog', kind: 'article:en', url: postUrl.blog('claudio-v1-5-per-key-budgets'), externalId: 'src/content/posts/en/claudio-v1-5-per-key-budgets.md', publishedAt: claudioAt });
  const claudioBsky = await seedPiece(registry, claudio, { channel: 'bluesky', account: accounts.get('bluesky'), url: postUrl.bluesky('3l7claudio15x'), externalId: 'at://did:plc:previewjosegarrido/app.bsky.feed.post/3l7claudio15x', publishedAt: claudioAt });
  const claudioMasto = await seedPiece(registry, claudio, { channel: 'mastodon', account: accounts.get('mastodon'), url: postUrl.mastodon('113380000000000002'), externalId: '113380000000000002', publishedAt: new Date(claudioAt.getTime() + 5 * 60_000) });
  const claudioDevto = await seedPiece(registry, claudio, { channel: 'devto', account: accounts.get('devto'), url: postUrl.devto('claudio-v150-per-key-budgets-and-streaming-tools-4k2p'), externalId: '2081553', publishedAt: new Date(claudioAt.getTime() + 10 * 60_000) });
  // 928 views (the blog's 775 and dev.to's 153), 84 reactions (Telegram's piece is not out yet), 11 comments; 212 views on the blog on 21 Oct
  await seedBlog(registry, claudio, '2026-10-20', [180, 212, 120, 80, 55, 40, 30, 22, 16, 10, 6, 4], 0.21);
  await seedReadings(registry, claudio, claudioBsky, 'bluesky', '2026-10-20', { likes: 48, replies: 5, reposts: 9, quotes: 2 });
  await seedReadings(registry, claudio, claudioMasto, 'mastodon', '2026-10-20', { favourites: 22, replies: 4, boosts: 6 });
  await seedReadings(registry, claudio, claudioDevto, 'devto', '2026-10-20', { views: 153, reactions: 14, comments: 2 }, { views: [60, 40, 20, 12, 8, 5, 3, 2, 1, 1, 1, 0] });
  // LinkedIn failed for good: the failure the launch page offers to retry, and the attempt that says so
  await registry.cursors.setCursor(failureKey(claudio.id, 'linkedin'), 'the token expired: reconnect LinkedIn, then retry');
  await exec(
    registry,
    `INSERT INTO publish_attempts (launch_id, channel, kind, state, attempts, error, started_at, updated_at) VALUES (${claudio.id}, 'linkedin', 'post', 'failed', 3, ${quote('the token expired: reconnect LinkedIn, then retry')}, ${quote(iso(new Date(claudioAt.getTime() + 12 * 60_000)))}, ${quote(iso(new Date(claudioAt.getTime() + 14 * 60_000)))})`,
  );
  // Telegram waits for its time, the next 10:00 in Madrid
  const scheduled = await registry.posts.schedulePost(claudio.id, 'telegram', nextMorning());
  if (scheduled) await exec(registry, `UPDATE posts SET account_id = ${accounts.get('telegram')!.id} WHERE id = ${scheduled.id}`);
  await linkPieces(registry, claudio);
  await seedJob(registry, 1, {
    queue: 'publish',
    title: 'Publishing yeyo11/claudio v1.5.0',
    launch: claudio,
    state: 'completed',
    log: ['Blog: published', 'Bluesky: published', 'Mastodon: published', 'dev.to: published', 'LinkedIn: the token expired, given up after 3 attempts', 'Telegram: scheduled for its time'],
    startedAt: new Date(claudioAt.getTime() - 60_000),
    endedAt: new Date(claudioAt.getTime() + 14 * 60_000),
  });

  // 3. sluice v2.0.0 failed before anything went out
  const sluiceAt = madrid('2026-10-29', '18:20');
  const sluice = await seedLaunch(registry, {
    repo: 'yeyo11/sluice',
    ref: 'v2.0.0',
    trigger: 'release',
    kind: 'major',
    status: 'failed',
    detail: 'claudio was overloaded',
    createdAt: sluiceAt,
    updatedAt: new Date(sluiceAt.getTime() + 6 * 60_000),
  });
  ids.sluice = sluice.id;
  await seedJob(registry, 2, {
    queue: 'draft',
    title: 'Drafting yeyo11/sluice v2.0.0',
    launch: sluice,
    state: 'failed',
    log: ['Reading the code and writing the pack; this takes a few minutes…', 'claudio answered 529: overloaded, trying again in 60 s', 'claudio answered 529: overloaded, trying again in 120 s', 'claudio was overloaded'],
    startedAt: new Date(sluiceAt.getTime() + 20_000),
    endedAt: new Date(sluiceAt.getTime() + 6 * 60_000),
  });

  // 4. pando v1.0.0 waits for the owner's approval, drafted 3 min ago
  const pando = await seedLaunch(registry, { repo: 'yeyo11/pando', ref: 'v1.0.0', trigger: 'release', kind: 'launch', status: 'drafted', createdAt: minutesAgo(11), updatedAt: minutesAgo(3) });
  ids.pando = pando.id;
  await hold(registry, pando, pandoPack(), brand, minutesAgo(3));
  await seedJob(registry, 3, {
    queue: 'draft',
    title: 'Drafting yeyo11/pando v1.0.0',
    launch: pando,
    state: 'completed',
    log: ['Reading the code and writing the pack; this takes a few minutes…', 'Wrote the article (en, es), Bluesky, LinkedIn and Mastodon', 'The drafts wait for your approval'],
    startedAt: minutesAgo(11),
    endedAt: minutesAgo(3),
  });

  // 5. shipcast v0.9.0 is being drafted, started 2 min ago by the release
  const shipcast = await seedLaunch(registry, { repo: 'yeyo11/shipcast', ref: 'v0.9.0', trigger: 'release', kind: 'minor', status: 'generating', createdAt: minutesAgo(2), updatedAt: minutesAgo(2) });
  ids.shipcast = shipcast.id;
  await parkDraft(registry, queue, shipcast);

  // Comments: two waiting with a reply drafted, five answered, one dismissed
  const comments: CommentSeed[] = [
    { post: claudioBsky, channel: 'bluesky', id: 'at-ana-1', handle: 'ana.bsky.social', name: 'Ana Ruiz', text: 'This looks great! Does it work with local models too?', at: hoursAgo(2), status: 'draft-ready', classification: 'question', draft: 'Yes: any OpenAI-compatible server works, local ones included. The README has an Ollama example.', note: 'A question the README answers: point to the Ollama example.' },
    { post: claudioMasto, channel: 'mastodon', id: '113390000000000101', handle: 'dev@hachyderm.io', name: 'Dev', text: 'Congrats on the release. How does it compare to LiteLLM?', at: hoursAgo(5), status: 'draft-ready', classification: 'question', draft: 'Thanks! Claudio is smaller on purpose: one binary, per-key budgets and streaming tools.', note: 'A comparison: say what claudio chose to be, without knocking LiteLLM.' },
    { post: claudioDevto, channel: 'devto', id: 'devto-c-31337', handle: 'mkline', name: 'Marta Kline', text: 'Per-key budgets is exactly what I needed for my side projects. Thanks for writing it up.', at: madrid('2026-10-21', '09:12'), status: 'sent', classification: 'praise', draft: 'Glad it helps! Tell me how the budgets work out for you.', sentAt: madrid('2026-10-21', '11:40') },
    { post: claudioBsky, channel: 'bluesky', id: 'at-pablo-2', handle: 'pablo.dev', name: 'Pablo', text: 'Does the streaming tools support work with Claude and GPT alike?', at: madrid('2026-10-20', '13:05'), status: 'sent', classification: 'question', draft: 'Yes, both: the tool calls stream the same way whichever provider answers.', sentAt: madrid('2026-10-20', '15:30') },
    { post: claudioMasto, channel: 'mastodon', id: '113390000000000102', handle: 'lucia@fosstodon.org', name: 'Lucía', text: 'Found a typo in the changelog: "budegts".', at: madrid('2026-10-20', '17:44'), status: 'sent', classification: 'bug', draft: 'Good catch, fixed. Thank you!', sentAt: madrid('2026-10-20', '19:02') },
    { post: articleBsky, channel: 'bluesky', id: 'at-irene-3', handle: 'irene.codes', name: 'Irene', text: 'I did the same last year and never looked back. Do you keep them in the same repo as the code?', at: madrid('2026-10-14', '11:20'), status: 'sent', classification: 'question', draft: 'Same repo, under docs/: the notes change with the code, in the same pull request.', sentAt: madrid('2026-10-14', '13:00') },
    { post: articleMasto, channel: 'mastodon', id: '113350000000000103', handle: 'tomas@mastodon.social', name: 'Tomás', text: 'Nice write-up. How do you search them?', at: madrid('2026-10-15', '08:31'), status: 'sent', classification: 'question', draft: 'With pando: it indexes docs/ and the code, so one search finds both.', sentAt: madrid('2026-10-15', '10:15') },
    { post: articleBsky, channel: 'bluesky', id: 'at-spam-4', handle: 'cryptodeals.bsky.social', name: 'Crypto Deals', text: 'Earn 10x with our new token, link in bio!', at: madrid('2026-10-14', '20:02'), status: 'dismissed', classification: 'spam', note: 'Spam: nothing to answer.' },
  ];
  for (const c of comments) await seedComment(registry, c);

  return ids;
}


// ---- main ----

const config = loadConfig(process.env, ROOT);
const secrets = secretStoreFor(config);
const parsed = parseBrand(BRAND_YML);
if (!parsed.ok) fail(`the seed's brand does not parse: ${parsed.issues.map((i) => i.message).join('; ')}`);
const brand = parsed.value;

const registry = await connectRepositories(url, poolOptions(process.env));
// The app's own queue, only to send: no cron, no maintenance, no reconciliation, no worker
const queue = WorkQueue.postgres(url, registry, { schedule: false, supervise: false, reconcileAtStart: false, instanceName: 'preview-seed', poolMax: 1 });
try {
  // Checked again on the server's own word: the URL could name one database and reach another through a proxy
  const rows = (await registry.database.execute('SELECT current_database() AS name')) as unknown as Array<{ name: string }>;
  const name = rows[0]?.name ?? '';
  if (!/_preview$/.test(name)) fail(`refusing to run: the server says this is "${name}", not a _preview database`);

  // pg-boss's schema first: a database the app never ran on has none, and the wipe clears its jobs
  await queue.start();
  await wipe(registry, secrets);
  await seedSettings(registry, secrets);
  if (EMPTY) {
    console.log(`Seeded ${name} empty: a finished onboarding, its settings, no accounts, launches or comments.`);
  } else {
    const accounts = await seedAccounts(registry, secrets, brand);
    const ids = await seedLaunches(registry, queue, accounts, brand);
    console.log(`Seeded ${name}: ${accounts.size} accounts; launches ${Object.entries(ids).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  const fixtures = writeFixtures();
  if (fixtures) console.log(`Wrote the GitHub fixtures (brand.yml, launch.yml, held drafts) under ${fixtures}`);
  // The running app reads its settings again at a round's start; with automation off the round does nothing else
  await scheduleRound(queue, 'preview seed');
  console.log('Queued a round so the running app reads the settings again (automation is off: the round does nothing else).');
} finally {
  await queue.stop(5_000);
  await registry.close();
}

/*
 * Notes: what the preview cannot show from rows alone
 *
 * - The blog is no account: Shipcast publishes it through the launches repo, so Channels has no blog
 *   row to seed; its pieces are `posts` rows with no account.
 * - pando's and claudio's drafts show only with the launch model's flags on (see the header); without
 *   them the app reads drafts from a pull request on GitHub, which does not exist. The other three
 *   launches are legacy ones with no pull request: their pages have no drafts.
 * - pando's pieces are not put on a time: a drafted launch with a scheduled piece is listed as
 *   "Scheduled" instead of "Waiting for you"; the Channels tab's scheduler shows the free slots.
 * - Bluesky and Mastodon count no views (their families have none), so a launch's views are the
 *   blog's and dev.to's.
 * - shipcast v0.9.0's draft is a real pg-boss job parked 13 days ahead (parkDraft): a preview left
 *   running that long drafts it against claudio's made-up address, which fails, and the launch with it.
 * - An article launch is listed as "Article": the app's launch view does not carry the launch's title.
 */
