import {
  buildServices,
  claimFromWebhook,
  draftClaimed,
  LAST_DELIVERY_KEY,
  launchOfPullRequest,
  readAutomation,
  record,
  verifySignature,
  WEBHOOK_SECRET_KEY,
  webhookAction,
} from '@shipcast/runtime';
import { roundDeps } from './automation.server';
import { appContext } from './context.server';
import { startPublishing } from './work.server';

const answer = (status: number, message: string) => Response.json({ message }, { status });

/**
 * A delivery from GitHub. It is trusted only when its signature matches the secret set in the
 * Automation page; it is acted on only while webhooks are the chosen mode. The answer comes at once
 * (GitHub gives up after ten seconds); drafting and publishing run as background work.
 */
export async function receiveWebhook(request: Request): Promise<Response> {
  const ctx = appContext();
  const secret = await ctx.secrets.get(WEBHOOK_SECRET_KEY);
  if (!secret) return answer(503, 'webhooks are not set up in Shipcast: generate a secret in Automation');
  const body = await request.text();
  if (!verifySignature(secret, body, request.headers.get('x-hub-signature-256'))) return answer(401, 'the signature does not match the secret');

  const event = request.headers.get('x-github-event');
  const delivery = request.headers.get('x-github-delivery') ?? 'unknown';
  const done = (status: number, summary: string, lines: string[] = []) => {
    record(ctx.registry, LAST_DELIVERY_KEY, { at: new Date().toISOString(), summary: `${event ?? 'event'} ${delivery.slice(0, 8)}: ${summary}`, lines });
    return answer(status, summary);
  };

  let payload: Parameters<typeof webhookAction>[1];
  try {
    payload = JSON.parse(body) as Parameters<typeof webhookAction>[1];
  } catch {
    return done(400, 'the body is not JSON: set the content type to application/json');
  }
  const action = webhookAction(event, payload, ctx.config.launchesRepo);
  if (action.kind === 'ping') return done(200, 'pong: the webhook reaches Shipcast');
  if (readAutomation(ctx.registry).mode !== 'webhook') return done(200, 'received, but webhooks are turned off in Automation');
  if (action.kind === 'ignore') return done(200, `ignored: ${action.reason}`);

  const d = await roundDeps(ctx, () => {});
  if (action.kind === 'claim') {
    const outcome = await claimFromWebhook(d, action.event);
    if (outcome.result !== 'claimed') return done(200, outcome.result === 'ignored' ? `ignored: ${outcome.reason}` : outcome.result);
    const services = await buildServices({ env: process.env, brand: d.brand, registry: d.registry, github: d.github, secrets: d.secrets });
    ctx.jobs.start(`Drafting ${outcome.launch.repo} ${outcome.launch.ref}`, async (log) => {
      await draftClaimed(outcome.launch, { ...d, log }, services);
      return `/launches/${outcome.launch.id}`;
    });
    return done(202, `claimed ${outcome.launch.repo} ${outcome.launch.ref}: drafting`);
  }
  const launch = launchOfPullRequest(d, action.pullRequestUrl);
  if (!launch) return done(200, 'a merge Shipcast has no drafted launch for');
  startPublishing(launch);
  return done(202, `publishing ${launch.repo} ${launch.ref}`);
}
