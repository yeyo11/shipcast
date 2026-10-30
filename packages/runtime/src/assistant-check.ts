import { AssistantRefused, checkAgainstCode, launchCodeRef, launchGrounding, type CheckAnswer, type JobRecord, type Launch, type PipelineDeps, type Repositories } from '@shipcast/engine';
import type { Brand } from '@shipcast/schema';
import type { JobData, JobQueue } from './queue.ts';

/*
 * The writing assistant's "Check against the code" as a heavy job: a clone and an
 * agent reading it for minutes never run inside a page's request. The page sends the request, gets
 * the job's id, follows the job's row through its live events (or reads it every few seconds), and
 * reads the result once the job has ended. The result is kept under the job's id; a day later it is
 * swept by the next check.
 */

const RESULT_PREFIX = 'assistant-check:';
/** How long a check's result waits for its page */
const KEEP_MS = 24 * 3600_000;

const resultKey = (jobId: string) => `${RESULT_PREFIX}${jobId}`;

interface StoredResult extends CheckAnswer {
  at: string;
}

/** Queues the check of a launch's text against its code; the job's id is what the page follows */
export async function startAssistantCheck(queue: Pick<JobQueue, 'send'>, launch: Pick<Launch, 'id' | 'repo' | 'ref'>, request: Omit<JobData['assistant-check'], 'launchId'>): Promise<string> {
  const id = await queue.send(
    'assistant-check',
    { launchId: launch.id, text: request.text, ...(request.lang && { lang: request.lang }), ...(request.channel && { channel: request.channel }) },
    { title: `Checking a text of ${launch.repo} ${launch.ref} against its code`, launchId: launch.id },
  );
  // A standard queue never declines a job; a null id would leave the page waiting for nothing
  if (!id) throw new Error('the check could not be queued');
  return id;
}

export interface AssistantCheckDeps {
  registry: Pick<Repositories, 'launches' | 'cursors'>;
  pipeline: PipelineDeps;
  brand: Brand;
  now?: () => Date;
}

/**
 * The job: the launch's grounding and its released code, checked on the runner, the answer kept for
 * the page. A launch without code or the provider's failure fails the job with why.
 */
export async function runAssistantCheck(d: AssistantCheckDeps, data: JobData['assistant-check'], job: { id: string; log(line: string): void; signal?: AbortSignal }): Promise<void> {
  const launch = await d.registry.launches.get(data.launchId);
  if (!launch) throw new AssistantRefused(`there is no launch ${data.launchId}`);
  const grounding = await launchGrounding(launch, { github: d.pipeline.github, launchesRepo: d.pipeline.launchesRepo, stored: d.pipeline.launchRead });
  if (grounding.kind !== 'launch' || !grounding.launch) throw new AssistantRefused('an article has no code to check against: the article itself is the truth');
  const texts = (await d.pipeline.aiTexts?.()) ?? {};
  const checkout = await d.pipeline.checkout(launch.repo, launchCodeRef(launch));
  const answer = await checkAgainstCode(
    data.text,
    { kind: 'launch', document: '', launch: grounding.launch, ...(data.lang && { lang: data.lang }), ...(data.channel && { channel: data.channel }) },
    {
      runner: d.pipeline.aiRunner,
      brand: d.brand,
      ...(texts.tone && { tone: texts.tone }),
      checkout,
      ...(job.signal && { signal: job.signal }),
    },
  );
  const now = d.now?.() ?? new Date();
  await sweep(d.registry, now);
  const stored: StoredResult = { ...answer, at: now.toISOString() };
  await d.registry.cursors.setCursor(resultKey(job.id), JSON.stringify(stored));
  const unbacked = answer.findings.filter((f) => f.verdict !== 'backed').length;
  job.log(`Checked ${answer.findings.length} claim${answer.findings.length === 1 ? '' : 's'}: ${unbacked} not backed by the code`);
}

/** Results nobody came back for */
async function sweep(registry: Pick<Repositories, 'cursors'>, now: Date): Promise<void> {
  for (const { key, value } of await registry.cursors.cursorsWithPrefix(RESULT_PREFIX)) {
    let at = Number.NaN;
    try {
      at = Date.parse((JSON.parse(value) as Partial<StoredResult>).at ?? '');
    } catch {
      // Not ours to read: gone with the others
    }
    if (!(now.getTime() - at < KEEP_MS)) await registry.cursors.deleteCursor(key).catch(() => undefined);
  }
}

/** Where a check stands, as its page reads it: still running, its answer, or why it failed */
export type AssistantCheckState =
  | { state: 'running' }
  | ({ state: 'done' } & CheckAnswer)
  | { state: 'failed'; problem: string };

export async function assistantCheckState(registry: Pick<Repositories, 'jobs' | 'cursors'>, jobId: string): Promise<AssistantCheckState | undefined> {
  const job: JobRecord | undefined = await registry.jobs.job(jobId);
  if (!job || job.queue !== 'assistant-check') return undefined;
  if (job.state === 'failed') return { state: 'failed', problem: job.log.at(-1) ?? 'the check failed' };
  if (job.state !== 'completed') return { state: 'running' };
  const text = await registry.cursors.cursor(resultKey(jobId));
  if (!text) return { state: 'failed', problem: 'the check’s result is no longer kept: check again' };
  const { revised, findings } = JSON.parse(text) as StoredResult;
  return { state: 'done', revised, findings };
}
