import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { CommentRecord, CommentRunResult, GitHubRest, PipelineDeps } from '@shipcast/engine';
import { clonePglite, connectPglite, registryOn } from '@shipcast/engine/testing';
import { checkComments, commentsNotice, MemoryStore, redraftComment, WorkQueue, workHandlers, writeAutomation, type QueueOptions } from '../src/index.ts';

const quiet: QueueOptions = { schedule: false, supervise: false, pollingIntervalSeconds: 0.5, onError: () => {} };

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

async function queue(): Promise<WorkQueue> {
  const client = await clonePglite((await template).client);
  const q = WorkQueue.pglite(client, await registryOn(client), quiet);
  queues.push(q);
  return q;
}

test('“Check comments now” twice is one queued run; drafting one comment again has a key of its own', async () => {
  const q = await queue();
  const first = await checkComments(q, 'by hand');
  assert.ok(first);
  assert.equal(await checkComments(q, 'by hand'), first, 'the run already queued answers');
  const redraft = await redraftComment(q, 7, 'by hand');
  assert.ok(redraft && redraft !== first);
  assert.equal(await redraftComment(q, 7, 'by hand'), redraft);
});

test('the scheduled run waits while automation is off; the brand is never read', async () => {
  const q = await queue();
  await writeAutomation(q.registry, { mode: 'off', intervalSeconds: 600 });
  let brandRead = false;
  const handlers = workHandlers(q, {
    env: {},
    registry: q.registry,
    github: {} as unknown as GitHubRest,
    secrets: new MemoryStore(),
    pipeline: {} as unknown as PipelineDeps,
    brand: async () => {
      brandRead = true;
      throw new Error('no brand');
    },
  });
  const lines: string[] = [];
  await handlers.comments!({ reason: 'every 30 minutes' }, { id: 'x', attempt: 1, lastAttempt: true, log: (l) => lines.push(l), link: () => {}, signal: new AbortController().signal });
  assert.deepEqual(lines, ['Automation is off: the comments are read by hand']);
  assert.equal(brandRead, false);
});

test('the owner hears of a run only when something waits for them', () => {
  const empty: CommentRunResult = { posts: 3, found: 2, added: [], answeredByHand: 0, problems: [], drafted: [], sent: [], toDismiss: 0 };
  assert.equal(commentsNotice(empty), undefined);
  const drafted = { status: 'draft-ready', draft: 'Thanks!' } as CommentRecord;
  const notice = commentsNotice({ ...empty, added: [drafted, drafted], drafted: [drafted, drafted], toDismiss: 1 }, 'https://shipcast.example/');
  assert.equal(notice, 'Shipcast read 2 new comments on your posts; 2 replies are drafted and wait for your approval; 1 look like spam or abuse: https://shipcast.example/comments');
});
