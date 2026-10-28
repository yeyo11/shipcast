import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { AiTaskRunner, GitHubRest, PipelineDeps, Repositories } from '@shipcast/engine';
import {
  claudioAnswer,
  claudioChats,
  clonePglite,
  codeloadUrl,
  connectPglite,
  fakeClaudio,
  fakeClaudioRunner,
  fakeGitHubArchives,
  FakeGitHub,
  mockRunner,
  registryOn,
  scriptedModel,
  submitParts,
} from '@shipcast/engine/testing';
import { Brand } from '@shipcast/schema';
import { assistantCheckState, MemoryStore, QUEUE_ROLES, startAssistantCheck, WorkQueue, workHandlers, type QueueOptions } from '../src/index.ts';
import { withEvents } from '../src/realtime/publish.ts';
import { MemoryEventBus } from '../src/redis/index.ts';

/*
 * The writing assistant's check against the code as a heavy job (`ai-runner`), end to end on the
 * real queue (pg-boss on PGlite): the page's request queues it, the heavy worker clones and runs the
 * check task on the runner, the job's row announces itself on the bus as it moves, and the page
 * reads the result under the job's id once the job has ended.
 */

const quiet: QueueOptions = { schedule: false, supervise: false, pollingIntervalSeconds: 0.5, onError: () => {} };
const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
const answer = { revised: 'claudio has a REST API.', findings: [{ claim: 'claudio runs on Windows', verdict: 'planned', evidence: 'docs/status.md lists it as planned' }] };
// The pack the launch's drafts committed: its analysis is what the check is grounded in
const pack = {
  schemaVersion: 1,
  kind: 'launch',
  project: { name: 'claudio', repo: 'https://github.com/yeyo11/claudio', version: 'v1.0.0' },
  analysis: { summary: 's', implemented: ['REST API'], planned: ['Windows support'], documentedOnly: [], limitations: [] },
  bluesky: { lang: 'en', text: 'b' },
};

const template = (async () => {
  const { client, close } = await connectPglite();
  const queue = WorkQueue.pglite(client, await registryOn(client), quiet);
  await queue.start();
  await queue.stop();
  return { client, close };
})();

const queues: WorkQueue[] = [];
after(async () => {
  await Promise.all(queues.splice(0).map((q) => q.stop(1000)));
  await (await template).close();
});

async function world(runner: AiTaskRunner | undefined) {
  const client = await clonePglite((await template).client);
  const bus = new MemoryEventBus();
  const events: Array<{ id: string; queue: string; state: string; launchId: number | null }> = [];
  await bus.subscribe('job.changed', (payload) => events.push(payload));
  const { registry, flush } = withEvents(await registryOn(client), bus);
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  const github = new FakeGitHub({ files: { 'yeyo11/launches/launches/claudio/v1.0.0/pack.json@HEAD': JSON.stringify(pack) } });
  const hostPath = await mkdtemp(join(tmpdir(), 'shipcast-check-'));
  const clones: string[] = [];
  const pipeline = {
    github,
    registry,
    launchesRepo: 'yeyo11/launches',
    checkout: async (repo: string, ref: string) => {
      clones.push(`${repo}@${ref}`);
      return { hostPath, providerPath: '' };
    },
    ...(runner && { aiRunner: runner, aiTexts: async () => ({ tone: 'Plain words.' }) }),
  } as unknown as PipelineDeps;
  const queue = WorkQueue.pglite(client, registry, quiet);
  queues.push(queue);
  await queue.work(workHandlers(queue, { env: {}, registry: registry as Repositories, github: github as unknown as GitHubRest, secrets: new MemoryStore(), pipeline, brand: async () => brand }));
  return { registry, queue, launch, events, flush, clones };
}

test('the check is a heavy job, never the web’s', () => {
  assert.equal(QUEUE_ROLES['assistant-check'], 'heavy');
});

test('a check sent by the page runs as a job on the runner, announces itself, and leaves its result for the page', async () => {
  const model = scriptedModel(submitParts(answer));
  const w = await world(mockRunner(model));
  const id = await startAssistantCheck(w.queue, w.launch, { text: 'claudio has a REST API and runs on Windows.', channel: 'bluesky' });
  assert.deepEqual(await assistantCheckState(w.registry, id), { state: 'running' });
  const ended = await w.queue.wait(id, 20_000, 100);
  assert.equal(ended?.state, 'completed', ended?.log.join('\n'));
  assert.deepEqual(ended?.log, ['Checked 1 claim: 1 not backed by the code']);
  assert.deepEqual(await assistantCheckState(w.registry, id), { state: 'done', ...answer });

  assert.deepEqual(w.clones, ['yeyo11/claudio@v1.0.0'], 'the release, cloned in the job');
  const prompt = JSON.stringify(model.doStreamCalls[0]!.prompt);
  for (const piece of ['runs on Windows', 'Windows support', 'Plain words.', 'yeyo11/claudio']) assert.ok(prompt.includes(piece), piece);
  assert.ok((model.doStreamCalls[0]!.tools ?? []).some((t) => t.name === 'read_files'), 'the clone read with the runner’s tools');

  await w.flush();
  const mine = w.events.filter((e) => e.id === id);
  assert.ok(mine.length > 0, 'the job’s row announced itself');
  assert.deepEqual(mine.at(-1), { id, queue: 'assistant-check', state: 'completed', launchId: w.launch.id }, 'its end is the event the page waits for');
});

test('a provider’s failure fails the job with why, and the page reads that', async () => {
  // An answer still invalid after its repair: the runner's AiError, as a provider's own refusal would be
  const w = await world(mockRunner(scriptedModel(submitParts({ revised: 1 }), submitParts({ revised: 2 }, 'call-2'))));
  const id = await startAssistantCheck(w.queue, w.launch, { text: 'x' });
  const ended = await w.queue.wait(id, 20_000, 100);
  assert.equal(ended?.state, 'failed');
  const state = await assistantCheckState(w.registry, id);
  assert.equal(state?.state, 'failed');
  assert.match(state?.state === 'failed' ? state.problem : '', /answer to assistant-check is not valid, even after a repair/);
  await w.flush();
  assert.equal(w.events.filter((e) => e.id === id).at(-1)?.state, 'failed');
});

test('without the runner the job refuses to run: the page never sends one with the flag off', async () => {
  const w = await world(undefined);
  const id = await startAssistantCheck(w.queue, w.launch, { text: 'x' });
  const ended = await w.queue.wait(id, 20_000, 100);
  assert.equal(ended?.state, 'failed');
  assert.match(ended?.log.at(-1) ?? '', /needs the ai-runner flag/);
});

test('on Claudio the job reads the release in a workspace of its own, with the check task’s turns', async () => {
  const claudio = await fakeClaudio({ chat: (_, res) => claudioAnswer(res, JSON.stringify(answer)) });
  const gh = await fakeGitHubArchives();
  try {
    const w = await world(fakeClaudioRunner(claudio, gh));
    const id = await startAssistantCheck(w.queue, w.launch, { text: 'claudio runs on Windows.' });
    assert.equal((await w.queue.wait(id, 20_000, 100))?.state, 'completed');
    assert.deepEqual(await assistantCheckState(w.registry, id), { state: 'done', ...answer });
    assert.deepEqual(JSON.parse(claudio.seen[0]!.body), { url: codeloadUrl('yeyo11/claudio', 'v1.0.0') });
    assert.equal(claudioChats(claudio)[0]!.headers['x-claudio-max-turns'], '30');
    assert.ok(claudio.seen.some((s) => s.method === 'DELETE'), 'the workspace released');
  } finally {
    await Promise.all([claudio.close(), gh.close()]);
  }
});
