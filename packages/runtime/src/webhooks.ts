import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { claimEvent, type GitHubEvent, type Launch, type Outcome } from '@shipcast/engine';
import type { RoundDeps } from './rounds.ts';

/** The keychain key of the webhook's secret */
export const WEBHOOK_SECRET_KEY = 'app:github-webhook-secret';

/** A new secret for GitHub to sign deliveries with: 32 random bytes, as GitHub's docs advise */
export function newWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Whether a delivery comes from GitHub: `X-Hub-Signature-256` is `sha256=` and the HMAC-SHA256 of
 * the exact body with the shared secret, compared in constant time so the comparison leaks nothing.
 */
export function verifySignature(secret: string, body: string, header: string | null): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** What a delivery asks Shipcast to do, decided from its event and payload alone */
export type WebhookAction =
  | { kind: 'ping' }
  | { kind: 'claim'; event: GitHubEvent }
  | { kind: 'publish'; pullRequestUrl: string }
  | { kind: 'ignore'; reason: string };

interface Payload {
  action?: string;
  zen?: string;
  repository?: { full_name?: string };
  release?: { id?: number; tag_name?: string; prerelease?: boolean; draft?: boolean; html_url?: string; published_at?: string };
  pull_request?: { html_url?: string; merged?: boolean };
}

/** Maps a delivery to an action. Only what Shipcast acts on is read; anything else is ignored with a reason. */
export function webhookAction(event: string | null, payload: Payload, launchesRepo: string): WebhookAction {
  const repo = payload.repository?.full_name;
  if (event === 'ping') return { kind: 'ping' };
  if (event === 'release') {
    const release = payload.release;
    if (payload.action !== 'published' || !release?.tag_name || !repo) return { kind: 'ignore', reason: `release ${payload.action ?? ''} is not a publication` };
    if (release.draft) return { kind: 'ignore', reason: 'a draft release' };
    return {
      kind: 'claim',
      event: {
        type: 'release',
        id: `webhook-${release.id ?? release.tag_name}`,
        repo,
        tag: release.tag_name,
        prerelease: release.prerelease ?? false,
        url: release.html_url ?? `https://github.com/${repo}/releases/tag/${release.tag_name}`,
        at: release.published_at ?? new Date().toISOString(),
      },
    };
  }
  if (event === 'repository' && payload.action === 'publicized' && repo) {
    return { kind: 'claim', event: { type: 'public', id: `webhook-public-${repo}`, repo, at: new Date().toISOString() } };
  }
  if (event === 'pull_request') {
    if (repo?.toLowerCase() !== launchesRepo.toLowerCase()) return { kind: 'ignore', reason: 'a pull request outside the launches repo' };
    if (payload.action !== 'closed' || !payload.pull_request?.merged || !payload.pull_request.html_url) return { kind: 'ignore', reason: 'not a merge' };
    return { kind: 'publish', pullRequestUrl: payload.pull_request.html_url };
  }
  return { kind: 'ignore', reason: `the ${event ?? 'unnamed'} event is not one Shipcast acts on` };
}

/** The launch whose drafts are in that pull request */
export function launchOfPullRequest(d: Pick<RoundDeps, 'registry'>, url: string): Launch | undefined {
  return d.registry.recent(500).find((l) => l.status === 'drafted' && l.detail === url);
}

/** Claims the release a webhook announced, by the same rules as polling */
export function claimFromWebhook(d: Pick<RoundDeps, 'github' | 'registry' | 'brand'>, event: GitHubEvent): Promise<Outcome> {
  return claimEvent(event, { github: d.github, registry: d.registry, brand: d.brand });
}
