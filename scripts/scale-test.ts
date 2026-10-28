import { lookup } from 'node:dns/promises';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { connectRepositories, GitHubRest, loadBrand, PostgresFakeNetworkLedger, PreviewScaleStore, readWindow, SecretRows, TelemetryStore } from '../packages/engine/src/index.ts';
import type { Launch, OpenRepositories } from '../packages/engine/src/index.ts';
import {
  activePublishJob,
  checkScale,
  parseExercise,
  planScale,
  poolOptions,
  previewFixtures,
  runId,
  SCALE_CHANNELS,
  scaleFiles,
  scaleMarkdown,
  scaleTargetProblems,
  TableStore,
  withGitHubFixtures,
} from '../packages/runtime/src/index.ts';
import type { ApiJob, ExerciseEvent, PlannedLaunch, ScalePlan } from '../packages/runtime/src/index.ts';
import { processState } from '../packages/runtime/src/redis/index.ts';
import type { Brand, Channel } from '../packages/schema/src/index.ts';

/**
 * The scale test of docs/plans/goal-refactor.md (phase 10), driven against a preview with fake
 * networks; its logic is packages/runtime/src/preview/scale.ts. It runs inside the preview's compose
 * project (the `scale` service of infra's stacks/shipcast-preview), where it reaches the preview's
 * Postgres, Redis, fixtures folder and every web replica by address, and refuses anything else.
 *
 *   node scripts/scale-test.ts seed --pieces 200 --hours 24 [--in-minutes 10] [--tag scale] [--channels a,b]
 *   node scripts/scale-test.ts exercise --dir <dir> [--until <iso>] [--every-seconds 60] [--oauth-every 5]
 *   node scripts/scale-test.ts check --dir <dir> [--grace-minutes 10]
 *   node scripts/scale-test.ts run --pieces 200 --hours 24           seed, exercise until the last piece is due + 15 min, check
 *   node scripts/scale-test.ts active-publish [--timeout-seconds 900] prints the publish job running now, for chaos (a)
 *
 * Environment: SHIPCAST_DATABASE_URL (the preview's), SHIPCAST_SECRETS_KEY, the Redis URLs and flags
 * of the preview, SHIPCAST_PREVIEW_FIXTURES, SCALE_URL (http://web:8744: every replica behind the
 * name is reached by its own address) and SCALE_API_TOKEN (`node apps/cli/src/main.ts token create
 * scale --scopes read,write` in a preview container). Output: data/evals/<tag>-<run>/ (plan.json,
 * exercise.jsonl, summary.json, summary.md).
 */

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    pieces: { type: 'string', default: '200' },
    hours: { type: 'string', default: '24' },
    'in-minutes': { type: 'string', default: '10' },
    tag: { type: 'string', default: 'scale' },
    channels: { type: 'string' },
    dir: { type: 'string' },
    until: { type: 'string' },
    'every-seconds': { type: 'string', default: '60' },
    'oauth-every': { type: 'string', default: '5' },
    'grace-minutes': { type: 'string', default: '10' },
    'timeout-seconds': { type: 'string', default: '900' },
  },
});
const command = positionals[0];
const env = process.env;
const BASE = env.SCALE_URL ?? 'http://web:8744';
const TOKEN = env.SCALE_API_TOKEN ?? '';
const OAUTH_NETWORKS = ['youtube', 'instagram', 'threads', 'linkedin', 'reddit', 'mastodon'];
const ZONES = ['Europe/Madrid', 'Europe/Lisbon', 'Atlantic/Canary', 'Europe/London', 'Europe/Paris'];
const PAGES = ['/', '/launches', '/stats', '/channels', '/automation'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(message: string): never {
  console.error(`scale-test: ${message}`);
  process.exit(2);
}

/** The registry, after the hard check that this is the preview and nothing else */
async function openPreview(): Promise<OpenRepositories> {
  const url = env.SHIPCAST_DATABASE_URL ?? fail('SHIPCAST_DATABASE_URL is not set');
  const early = scaleTargetProblems(env, undefined);
  if (early.length > 0) fail(`refusing to run:\n- ${early.join('\n- ')}`);
  const registry = await connectRepositories(url, poolOptions(env));
  const problems = scaleTargetProblems(env, (await new PreviewScaleStore(registry.database).currentDatabase()) ?? '(unknown)');
  if (problems.length > 0) {
    await registry.close();
    fail(`refusing to run:\n- ${problems.join('\n- ')}`);
  }
  return registry;
}

/** Every replica behind SCALE_URL's name, each by its own address: a rollout changes them, so asked each time */
async function replicas(): Promise<string[]> {
  const base = new URL(BASE);
  try {
    const found = await lookup(base.hostname, { all: true, family: 4 });
    return found.map((a) => `${base.protocol}//${a.address}:${base.port || '80'}`).sort();
  } catch {
    return [base.origin];
  }
}

function outDir(tag: string, run: string): string {
  const dir = resolve('data/evals', `${tag}-${run}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const readPlan = (dir: string) => JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')) as ScalePlan;

async function api(origin: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; ms: number }> {
  const started = performance.now();
  const response = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined && { 'content-type': 'application/json' }), 'x-forwarded-proto': 'https' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON: kept as text
  }
  return { status: response.status, json, ms: Math.round(performance.now() - started) };
}

// ---- seed ----

async function seed(): Promise<string> {
  if (!TOKEN) fail('SCALE_API_TOKEN is not set');
  const registry = await openPreview();
  try {
    const fixtures = previewFixtures(env) ?? fail('SHIPCAST_PREVIEW_FIXTURES is not set: the seeded launches need their files served');
    const launchesRepo = (await registry.settings.setting<string>('launches-repo')) ?? env.SHIPCAST_LAUNCHES_REPO ?? fail('no launches repo in the settings or SHIPCAST_LAUNCHES_REPO');
    // A read of brand.yml: the preview's read-only token, and the fixtures first
    const github = new GitHubRest({ token: env.GITHUB_TOKEN_PERSONAL ?? '', fetch: withGitHubFixtures(fixtures, fetch) });
    const brand: Brand = await loadBrand(github, launchesRepo);
    let channels = (values.channels?.split(',').map((c) => c.trim()) as Channel[] | undefined) ?? [...SCALE_CHANNELS];
    if (!brand.newsletter?.lists.en && channels.includes('newsletter')) {
      console.error('The brand has no English newsletter list: the newsletter is left out of this run');
      channels = channels.filter((c) => c !== 'newsletter');
    }
    const now = new Date();
    const run = runId(now);
    const plan = planScale({ run, pieces: Number(values.pieces), start: new Date(now.getTime() + Number(values['in-minutes']) * 60_000), durationMs: Number(values.hours) * 3600_000, channels, now });
    const dir = outDir(values.tag!, run);
    const origins = await replicas();
    for (const [i, planned] of plan.launches.entries()) {
      // Detected first: a round only publishes drafted launches, so nothing goes out before its times are set
      const { launch } = await registry.launches.claim({ repo: planned.repo, ref: planned.ref, trigger: 'manual', kind: 'launch', brand: brand.id });
      await registry.launches.setStatus(launch.id, 'detected', `direct:scale ${run}`);
      writeFiles(fixtures, planned, launch, launchesRepo, brand);
      planned.launchId = launch.id;
      const origin = origins[i % origins.length]!;
      const answer = await api(origin, 'POST', `/launches/${launch.id}/schedule`, { times: planned.times });
      if (answer.status !== 200) fail(`scheduling launch ${launch.id} on ${origin}: ${answer.status} ${JSON.stringify(answer.json)}`);
      await registry.launches.setStatus(launch.id, 'drafted', `direct:scale ${run}`);
      console.error(`launch ${planned.index} (#${launch.id}): ${Object.keys(planned.times).length} pieces scheduled through ${origin}`);
    }
    writeFileSync(join(dir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    console.error(`Seeded ${plan.pieces} pieces in ${plan.launches.length} launches, due ${plan.start} to ${plan.end}`);
    console.log(dir);
    return dir;
  } finally {
    await registry.close();
  }
}

function writeFiles(fixtures: NonNullable<ReturnType<typeof previewFixtures>>, planned: PlannedLaunch, launch: Launch, launchesRepo: string, brand: Brand): void {
  const files = scaleFiles(planned, launch, { launchesRepo, site: brand.site, brand: brand.id });
  for (const f of files.github) fixtures.writeGitHub(f.repo, f.path, f.content);
  for (const f of files.site) fixtures.writeSite(f.url, f.content);
}

// ---- exercise ----

interface Session {
  cookie: string;
}

/** A session through a console link (the app's own way in without GitHub), made in the preview's Redis */
async function signIn(origin: string): Promise<Session> {
  const token = await processState(env, 'scale').shared.oneTime.put('console-link', 1, 15 * 60);
  const response = await fetch(`${origin}/auth/link?token=${token}`, { redirect: 'manual', headers: { 'x-forwarded-proto': 'https' } });
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .join('; ');
  if (!cookie.includes('sc_session=')) fail(`the console link did not sign in on ${origin} (${response.status})`);
  return { cookie };
}

async function timed(kind: string, replica: string, request: () => Promise<Response>, ok: (r: Response) => boolean | Promise<boolean>, detail?: (r: Response) => string): Promise<{ event: ExerciseEvent; response: Response | undefined }> {
  const started = performance.now();
  const at = new Date().toISOString();
  try {
    const response = await request();
    const good = await ok(response);
    return { event: { at, kind, replica, ok: good, status: response.status, ms: Math.round(performance.now() - started), ...(detail && { detail: detail(response) }) }, response };
  } catch (error) {
    return { event: { at, kind, replica, ok: false, status: 0, ms: Math.round(performance.now() - started), detail: error instanceof Error ? error.message : String(error) }, response: undefined };
  }
}

async function exercise(dir: string, until: Date): Promise<void> {
  const plan = readPlan(dir);
  const log = join(dir, 'exercise.jsonl');
  const write = (event: ExerciseEvent) => appendFileSync(log, `${JSON.stringify(event)}\n`);
  const registry = await openPreview();
  const secrets = env.SHIPCAST_SECRETS_KEY ? new TableStore(new SecretRows(registry.database), Buffer.from(env.SHIPCAST_SECRETS_KEY, 'base64')) : undefined;
  if (!secrets) console.error('No SHIPCAST_SECRETS_KEY: the secret writes are checked for their row only');
  let session = await signIn((await replicas())[0]!);
  const every = Number(values['every-seconds']) * 1000;
  const oauthEvery = Math.max(1, Number(values['oauth-every']));
  const launchIds = plan.launches.map((l) => l.launchId).filter((id): id is number => id !== undefined);
  let tick = 0;
  let trips = 0;
  try {
    while (Date.now() < until.getTime()) {
      const started = Date.now();
      const origins = await replicas();
      const headers = () => ({ cookie: session.cookie, 'x-forwarded-proto': 'https' });

      // Pages, one per replica, rotating; a redirect to the sign-in is a failure (and a new session)
      for (const [i, origin] of origins.entries()) {
        const id = launchIds[(tick + i) % Math.max(1, launchIds.length)];
        const pages = id === undefined ? PAGES : [...PAGES, `/launches/${id}`];
        const path = pages[(tick + i) % pages.length]!;
        const { event } = await timed('page', origin, () => fetch(`${origin}${path}`, { redirect: 'manual', headers: headers() }), (r) => r.status < 300, () => path);
        write(event);
        if (event.status >= 300 && event.status < 400) session = await signIn(origin);
      }

      // A Settings save on one replica, read back on every other
      const saver = origins[tick % origins.length]!;
      const zone = ZONES[tick % ZONES.length]!;
      const saved = await timed('settings-save', saver, () => fetch(`${saver}/api/v1/settings/timezone`, { method: 'PATCH', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ timezone: zone }) }), (r) => r.ok, () => zone);
      write(saved.event);
      if (saved.event.ok) {
        await sleep(1500);
        for (const reader of origins.filter((o) => o !== saver)) {
          const read = await timed('settings-read', reader, () => fetch(`${reader}/api/v1/settings/timezone`, { headers: { authorization: `Bearer ${TOKEN}` } }), async (r) => r.ok && ((await r.clone().json()) as { timezone?: string }).timezone === zone, () => `expected ${zone}`);
          write(read.event);
        }
      }

      // A read of the API, as a client polls it
      const reader = origins[(tick + 1) % origins.length]!;
      if (launchIds.length > 0) write((await timed('api', reader, () => fetch(`${reader}/api/v1/launches/${launchIds[tick % launchIds.length]}`, { headers: { authorization: `Bearer ${TOKEN}` } }), (r) => r.ok)).event);

      // Sign-ins started on one replica and finished on the next, on every replica at once, each secret checked right after
      if (tick % oauthEvery === 0) {
        await Promise.all(
          origins.map(async (start, i) => {
            const finish = origins[(i + 1) % origins.length]!;
            const network = OAUTH_NETWORKS[(trips + i) % OAUTH_NETWORKS.length]!;
            const label = `scale-${plan.run}-${trips + i}`;
            const query = new URLSearchParams({ label, ...(network === 'mastodon' && { instance: 'https://mastodon.example' }) });
            const begun = await timed('oauth-start', start, () => fetch(`${start}/auth/${network}?${query}`, { redirect: 'manual', headers: headers() }), (r) => r.status === 302 && (r.headers.get('location') ?? '').includes(`/auth/${network}/callback?`), () => network);
            write(begun.event);
            const location = begun.response?.headers.get('location');
            if (!begun.event.ok || !location) return;
            const back = new URL(location);
            const done = await timed('oauth-callback', finish, () => fetch(`${finish}${back.pathname}${back.search}`, { redirect: 'manual', headers: headers() }), (r) => r.status === 302 && (r.headers.get('location') ?? '').includes('connected='), (r) => `${network} ${label}: ${r.headers.get('location') ?? ''}`);
            write(done.event);
            if (done.event.ok) write(await checkSecret(registry, secrets, network, label));
          }),
        );
        trips += origins.length;
      }

      tick += 1;
      await sleep(Math.max(0, every - (Date.now() - started)));
    }
  } finally {
    await processState(env, 'scale').close();
    await registry.close();
  }
}

/**
 * The secret a sign-in wrote, read back from the table and opened, then the account removed: the
 * made-up accounts must not linger where the hourly reads would try them on a real network.
 */
async function checkSecret(registry: OpenRepositories, secrets: TableStore | undefined, network: string, label: string): Promise<ExerciseEvent> {
  const at = new Date().toISOString();
  const account = (await registry.accounts.accounts({ network })).find((a) => a.label === label);
  if (!account) return { at, kind: 'secret', replica: '-', ok: false, status: 0, ms: 0, detail: `${label}: no account` };
  const key = `account:${account.id}`;
  let ok: boolean;
  if (secrets) {
    const value = await secrets.get(key).catch(() => undefined);
    ok = value !== undefined && (JSON.parse(value) as { accessToken?: string }).accessToken?.startsWith('preview-') === true;
    await secrets.delete(key);
  } else {
    const rows = new SecretRows(registry.database);
    ok = (await rows.get(key)) !== undefined;
    await rows.delete(key);
  }
  await registry.accounts.deleteAccount(account.id);
  return { at, kind: 'secret', replica: '-', ok, status: ok ? 200 : 0, ms: 0, detail: label };
}

// ---- check ----

async function check(dir: string): Promise<boolean> {
  const plan = readPlan(dir);
  const registry = await openPreview();
  try {
    const ids = plan.launches.map((l) => l.launchId).filter((id): id is number => id !== undefined);
    const rows = await new PreviewScaleStore(registry.database).pieces(ids);
    const ledger = await new PostgresFakeNetworkLedger(registry.database, 'scale').entries(plan.createdAt);
    const unknown = (await registry.attempts.inState('unknown')).map((a) => ({ launchId: a.launchId, channel: a.channel, kind: a.kind }));
    let exercise: ExerciseEvent[] = [];
    try {
      exercise = parseExercise(readFileSync(join(dir, 'exercise.jsonl'), 'utf8'));
    } catch {
      // no exercise in this run (a chaos batch checked on its own)
    }
    const now = new Date();
    const summary = checkScale({
      plan,
      registry: rows,
      ledger,
      unknown,
      exercise,
      secrets: exercise.filter((e) => e.kind === 'secret').map((e) => ({ label: e.detail ?? '?', accountId: null, secretFound: e.ok })),
      now,
      graceMs: Number(values['grace-minutes']) * 60_000,
    });
    const hour = (t: number) => new Date(Math.floor(t / 3600_000) * 3600_000).toISOString();
    const kpis = await readWindow(new TelemetryStore(registry.database), { from: hour(Date.parse(plan.createdAt)), to: hour(now.getTime() + 3600_000) });
    writeFileSync(join(dir, 'summary.json'), `${JSON.stringify({ ...summary, kpis }, null, 2)}\n`);
    writeFileSync(join(dir, 'summary.md'), scaleMarkdown(summary, `\`\`\`json\n${JSON.stringify(kpis, null, 2)}\n\`\`\``));
    console.log(`${summary.verdict.toUpperCase()}: ${summary.counts.ok}/${summary.counts.pieces} pieces exact; ${summary.problems.join('; ') || 'no problems'}`);
    console.log(join(dir, 'summary.md'));
    return summary.verdict === 'pass';
  } finally {
    await registry.close();
  }
}

// ---- active-publish ----

async function activePublish(): Promise<void> {
  if (!TOKEN) fail('SCALE_API_TOKEN is not set');
  const registry = await openPreview();
  await registry.close();
  const deadline = Date.now() + Number(values['timeout-seconds']) * 1000;
  while (Date.now() < deadline) {
    const origin = (await replicas())[0]!;
    const { status, json } = await api(origin, 'GET', '/jobs?limit=100');
    if (status === 200) {
      const job = activePublishJob((json as { jobs: ApiJob[] }).jobs);
      if (job) {
        console.log(JSON.stringify(job));
        return;
      }
    }
    await sleep(500);
  }
  fail('no publish job became active in time');
}

// ---- main ----

switch (command) {
  case 'seed':
    await seed();
    break;
  case 'exercise': {
    const dir = values.dir ?? fail('--dir is needed');
    const plan = readPlan(dir);
    await exercise(dir, values.until ? new Date(values.until) : new Date(Date.parse(plan.end) + 15 * 60_000));
    break;
  }
  case 'check':
    process.exitCode = (await check(values.dir ?? fail('--dir is needed'))) ? 0 : 1;
    break;
  case 'run': {
    const dir = await seed();
    await exercise(dir, new Date(Date.parse(readPlan(dir).end) + 15 * 60_000));
    process.exitCode = (await check(dir)) ? 0 : 1;
    break;
  }
  case 'active-publish':
    await activePublish();
    break;
  default:
    fail('usage: node scripts/scale-test.ts seed|exercise|check|run|active-publish (see the comment at the top)');
}
