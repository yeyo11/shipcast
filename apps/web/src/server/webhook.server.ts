import { githubEventEffects, LAST_DELIVERY_KEY, readAutomation, record, verifyAnySignature, WEBHOOK_SECRET_KEY, webhookAction, type GitHubEventEffects } from '@shipcast/runtime';
import { appContext, type AppContext } from './context.server';

const answer = (status: number, message: string) => Response.json({ message }, { status });

/**
 * GitHub caps a payload at 25 MB; the events Shipcast reads are a few KB, and a push's list of
 * files a few hundred. Past this a body is refused before it is read whole or hashed.
 */
export const MAX_WEBHOOK_BYTES = 5 * 1024 * 1024;

/** This process's delivery ids when the composition gave no shared one */

/**
 * A delivery from GitHub. It is trusted only when its signature matches the GitHub App's webhook
 * secret or the per-repo one set in the Automation page; it is acted on only while webhooks are the
 * chosen mode, except for the App's own installation events, which only refresh what Shipcast knows
 * of it. The answer comes at once (GitHub gives up after ten seconds); drafting and publishing run as
 * background work.
 *
 * With `github-events` a delivery also keeps what Shipcast holds of GitHub current, whatever the
 * mode: a `pull_request` of the launches repo queues its snapshot's read, a `push` forgets the files
 * it touched. Bodies are size-limited and a redelivery of an id already handled is dropped.
 */
export async function receiveWebhook(request: Request): Promise<Response> {
  const ctx = await appContext();
  const events = ctx.flags.on('github-events');
  const secrets = [ctx.config.githubApp?.webhookSecret, await ctx.secrets.get(WEBHOOK_SECRET_KEY)];
  if (!secrets.some(Boolean)) return answer(503, 'webhooks are not set up in Shipcast: generate a secret in Automation');
  if (events && Number(request.headers.get('content-length') ?? 0) > MAX_WEBHOOK_BYTES) return answer(413, 'the delivery is larger than Shipcast reads');
  const body = await request.text();
  if (events && Buffer.byteLength(body, 'utf8') > MAX_WEBHOOK_BYTES) return answer(413, 'the delivery is larger than Shipcast reads');
  if (!verifyAnySignature(secrets, body, request.headers.get('x-hub-signature-256'))) return answer(401, 'the signature does not match the secret');

  const event = request.headers.get('x-github-event');
  const delivery = request.headers.get('x-github-delivery') ?? 'unknown';
  // One seen-set: every replica's with redis-state, this process's otherwise; before github-events, as before, only with Redis
  const deliveries = delivery !== 'unknown' && (events || ctx.process.shared.backend === 'redis') ? ctx.process.shared.deliveries : undefined;
  // After the signature, so nobody can burn an id GitHub is about to send
  if (deliveries && !(await deliveries.claim(delivery))) return answer(200, `already handled delivery ${delivery.slice(0, 8)}`);
  try {
    return await handle(ctx, event, delivery, body, events);
  } catch (error) {
    // GitHub's redelivery of a delivery that failed here must be taken
    await deliveries?.release(delivery);
    throw error;
  }
}

async function handle(ctx: AppContext, event: string | null, delivery: string, body: string, events: boolean): Promise<Response> {
  const done = async (status: number, summary: string, lines: string[] = []) => {
    await record(ctx.registry, LAST_DELIVERY_KEY, { at: new Date().toISOString(), summary: `${event ?? 'event'} ${delivery.slice(0, 8)}: ${summary}`, lines });
    return answer(status, summary);
  };

  let payload: Parameters<typeof webhookAction>[1] & Parameters<typeof githubEventEffects>[1];
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    return done(400, 'the body is not JSON: set the content type to application/json');
  }
  const launchesRepo = ctx.settings.current().launchesRepo ?? '';
  // A push to the launches repo may change brand.yml: every replica reads the brand again
  if (event === 'push' && launchesRepo && payload.repository?.full_name?.toLowerCase() === launchesRepo.toLowerCase()) await ctx.announce('brand.changed', { repo: launchesRepo });
  const kept = events ? await applyEffects(ctx, githubEventEffects(event, payload, launchesRepo), delivery) : [];
  const action = webhookAction(event, payload, launchesRepo);
  if (action.kind === 'ping') return done(200, 'pong: the webhook reaches Shipcast');
  if (action.kind === 'installation') {
    // The next token is minted for the installation as it is now, on every replica
    await ctx.announce('github.installation.changed', { reason: action.summary });
    return done(200, `${action.summary}: Shipcast will look it up again`);
  }
  if ((await readAutomation(ctx.registry)).mode !== 'webhook') return done(200, kept.length > 0 ? kept.join('; ') : 'received, but webhooks are turned off in Automation', kept);
  if (action.kind === 'ignore') return done(200, kept.length > 0 ? kept.join('; ') : `ignored: ${action.reason}`, kept);

  // The claim reads launch.yml from GitHub and the draft takes minutes: both are a job of the
  // queue, so the answer is immediate and a restart in between loses nothing
  const what = action.kind === 'claim' ? `${action.event.repo} ${action.event.type === 'release' ? action.event.tag : 'made public'}` : action.pullRequestUrl;
  const job = await ctx.queue.send('delivery', { action, delivery }, { title: action.kind === 'claim' ? `Claiming ${what}` : `Publishing the merge of ${what}` });
  return done(202, `queued: ${action.kind === 'claim' ? `claiming ${what}` : `publishing ${what}`}${job ? '' : ' (already queued)'}`, kept);
}

/** Forgets the touched files at once (a cache delete) and queues the snapshot's read: nothing slow in the request */
async function applyEffects(ctx: AppContext, effects: GitHubEventEffects, delivery: string): Promise<string[]> {
  const lines: string[] = [];
  if (effects.forget && ctx.githubCaches) {
    await ctx.githubCaches.files.forget(effects.forget.repo, effects.forget.paths);
    lines.push(effects.forget.paths ? `forgot ${effects.forget.paths.length} files of ${effects.forget.repo}` : `forgot every file of ${effects.forget.repo}`);
  }
  if (effects.snapshot !== undefined && ctx.drafts) {
    const n = effects.snapshot;
    await ctx.queue.send('drafts-snapshot', { pullRequest: n, delivery }, { title: `Reading drafts pull request #${n}`, singletonKey: `pr:${n}` });
    lines.push(`reading pull request #${n} again`);
  }
  return lines;
}
