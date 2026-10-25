import { LAST_DELIVERY_KEY, readAutomation, record, verifyAnySignature, WEBHOOK_SECRET_KEY, webhookAction } from '@shipcast/runtime';
import { appContext } from './context.server';

const answer = (status: number, message: string) => Response.json({ message }, { status });

/**
 * A delivery from GitHub. It is trusted only when its signature matches the GitHub App's webhook
 * secret or the per-repo one set in the Automation page; it is acted on only while webhooks are the
 * chosen mode, except for the App's own installation events, which only refresh what Shipcast knows
 * of it. The answer comes at once (GitHub gives up after ten seconds); drafting and publishing run as
 * background work.
 */
export async function receiveWebhook(request: Request): Promise<Response> {
  const ctx = await appContext();
  const secrets = [ctx.config.githubApp?.webhookSecret, await ctx.secrets.get(WEBHOOK_SECRET_KEY)];
  if (!secrets.some(Boolean)) return answer(503, 'webhooks are not set up in Shipcast: generate a secret in Automation');
  const body = await request.text();
  if (!verifyAnySignature(secrets, body, request.headers.get('x-hub-signature-256'))) return answer(401, 'the signature does not match the secret');

  const event = request.headers.get('x-github-event');
  const delivery = request.headers.get('x-github-delivery') ?? 'unknown';
  const done = async (status: number, summary: string, lines: string[] = []) => {
    await record(ctx.registry, LAST_DELIVERY_KEY, { at: new Date().toISOString(), summary: `${event ?? 'event'} ${delivery.slice(0, 8)}: ${summary}`, lines });
    return answer(status, summary);
  };

  let payload: Parameters<typeof webhookAction>[1];
  try {
    payload = JSON.parse(body) as Parameters<typeof webhookAction>[1];
  } catch {
    return done(400, 'the body is not JSON: set the content type to application/json');
  }
  const action = webhookAction(event, payload, ctx.settings.current().launchesRepo ?? '');
  if (action.kind === 'ping') return done(200, 'pong: the webhook reaches Shipcast');
  if (action.kind === 'installation') {
    // The next token is minted for the installation as it is now
    ctx.githubApp?.refresh();
    return done(200, `${action.summary}: Shipcast will look it up again`);
  }
  if ((await readAutomation(ctx.registry)).mode !== 'webhook') return done(200, 'received, but webhooks are turned off in Automation');
  if (action.kind === 'ignore') return done(200, `ignored: ${action.reason}`);

  // The claim reads launch.yml from GitHub and the draft takes minutes: both are a job of the
  // queue, so the answer is immediate and a restart in between loses nothing
  const what = action.kind === 'claim' ? `${action.event.repo} ${action.event.type === 'release' ? action.event.tag : 'made public'}` : action.pullRequestUrl;
  const job = await ctx.queue.send('delivery', { action, delivery }, { title: action.kind === 'claim' ? `Claiming ${what}` : `Publishing the merge of ${what}` });
  return done(202, `queued: ${action.kind === 'claim' ? `claiming ${what}` : `publishing ${what}`}${job ? '' : ' (already queued)'}`);
}
