import { launchReplyContext, setupFor, type CommentRunResult, type PipelineDeps, type Repositories, type ReplyDeps } from '@shipcast/engine';
import type { GitHubTokenSource } from '@shipcast/connectors';
import type { Brand } from '@shipcast/schema';
import { commentConnectors } from './edits.ts';
import type { JobQueue } from './queue.ts';
import type { SecretStore } from './secrets.ts';

/*
 * The comment assistant's work: one job reads every live post's comments and drafts the replies,
 * every 30 minutes and on demand; another drafts one comment's reply again. Sending is never a job
 * of its own: the owner's click sends it, and auto mode sends inside the run that drafted it.
 * See docs/decisions/comment-assistant.md
 */

/** The key of the run: whichever process sends one, there is one queued and one running at most */
export const COMMENTS_KEY = 'comments';
/** Every half hour, in UTC */
export const COMMENTS_CRON = '*/30 * * * *';

export interface CommentWorkDeps {
  env: NodeJS.ProcessEnv;
  registry: Pick<Repositories, 'launches' | 'posts' | 'accounts' | 'comments' | 'settings' | 'cursors'>;
  secrets: SecretStore;
  pipeline: PipelineDeps;
  brand: Brand;
  fetch?: typeof fetch;
  /** The engine's GitHub access, which reads and answers GitHub Discussions */
  github?: { auth: GitHubTokenSource };
}

/** What the engine's assistant runs with in this process: the accounts' connectors, the `replies` AI task, the launches repo */
export function replyDeps(d: CommentWorkDeps): ReplyDeps {
  return {
    registry: d.registry,
    brand: d.brand,
    connectors: commentConnectors({ env: d.env, brand: d.brand, registry: d.registry, secrets: d.secrets, ...(d.fetch && { fetch: d.fetch }), ...(d.github && { github: d.github }) }),
    setup: () => setupFor(d.pipeline, 'replies'),
    context: launchReplyContext({
      github: d.pipeline.github,
      launchesRepo: d.pipeline.launchesRepo,
      checkout: d.pipeline.checkout,
      ...(d.pipeline.aiWorkdir && { aiWorkdir: d.pipeline.aiWorkdir }),
    }),
  };
}

/**
 * What the owner hears after a run, only when something waits for them or went out on its own;
 * a run that found nothing new says nothing.
 */
export function commentsNotice(result: CommentRunResult, publicUrl?: string): string | undefined {
  const ready = result.drafted.filter((c) => c.draft && c.status === 'draft-ready').length;
  if (ready === 0 && result.sent.length === 0 && result.toDismiss === 0) return undefined;
  const parts = [`Shipcast read ${result.added.length} new comment${result.added.length === 1 ? '' : 's'} on your posts`];
  if (ready > 0) parts.push(`${ready} repl${ready === 1 ? 'y is' : 'ies are'} drafted and wait for your approval`);
  if (result.sent.length > 0) parts.push(`${result.sent.length} sent on their own (auto mode)`);
  if (result.toDismiss > 0) parts.push(`${result.toDismiss} look like spam or abuse`);
  const where = publicUrl ? `: ${publicUrl.replace(/\/+$/, '')}/comments` : ': open Comments in Shipcast';
  return `${parts.join('; ')}${where}`;
}

/**
 * Queues a run by hand ("Check comments now"); the run already queued, if any, is the one that
 * answers, so clicking twice never reads twice.
 */
export async function checkComments(queue: JobQueue, reason: string): Promise<string | undefined> {
  const id = await queue.send('comments', { reason }, { title: 'Reading the comments, by hand', singletonKey: COMMENTS_KEY });
  if (id) return id;
  const [waiting] = await queue.queued('comments', COMMENTS_KEY);
  return waiting;
}

/** Queues a fresh draft of one comment's reply; a second click while it waits is the same job */
export async function redraftComment(queue: JobQueue, commentId: number, reason: string): Promise<string | undefined> {
  const key = `comment:${commentId}`;
  const id = await queue.send('comments', { reason, commentId }, { title: `Drafting the reply to comment ${commentId}`, singletonKey: key });
  if (id) return id;
  const [waiting] = await queue.queued('comments', key);
  return waiting;
}
