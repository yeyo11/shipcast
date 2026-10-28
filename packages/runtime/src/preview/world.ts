import { randomUUID } from 'node:crypto';
import type { BrevoCampaign, Check, Published, YouTubePublished, YouTubeVideo } from '@shipcast/connectors';
import { bindStrategy, describeSent, redditKind, type ChangeEditor, type ChannelPublishing, type EditDeps, type Editors, type FakeAction, type FakeNetworkLedger, type Notifier, type Publishers, type YouTubePublisher } from '@shipcast/engine';
import type { AnyChannelAdapter, Credentials } from '../channels/adapter.ts';
import { CHANNEL_ADAPTERS } from '../channels/registry.ts';
import type { Services } from '../services.ts';
import { withSiteFixtures, type PreviewFixtures } from './fixtures.ts';

/*
 * The fake networks of a preview (SHIPCAST_PREVIEW_FAKE_NETWORKS=1, guard.ts): every channel's
 * publisher, every strategy's publisher, every editor and the owner's notifier, each answering
 * success like its network and writing what it was sent to the preview's ledger, never to a network.
 * The tables below are typed against the engine's ports, and a test holds them against the channel
 * adapters, so a channel added without its fake fails the build or the test instead of reaching a
 * real network from a preview.
 */

const say = (line: string) => console.log(`[preview, fake network] ${line}`);

export interface PreviewWorldOptions {
  ledger: FakeNetworkLedger;
  fixtures?: PreviewFixtures | undefined;
  /** How long a fake network takes to answer a post, as a real one does (SHIPCAST_PREVIEW_FAKE_LATENCY_MS) */
  latencyMs?: number;
  /** The real fetch the reads go to; the global one by default */
  fetch?: typeof fetch;
  adapters?: readonly AnyChannelAdapter[];
}

/** What a fake network does on a call: wait like a network, record, answer with an id of its own */
type Send = (channel: string, action: FakeAction, kind: string, payload: unknown) => Promise<Published>;

function sender(options: PreviewWorldOptions): Send {
  return async (channel, action, kind, payload) => {
    if (options.latencyMs) await new Promise((r) => setTimeout(r, options.latencyMs));
    const externalId = `preview-${channel}-${randomUUID()}`;
    await options.ledger.record({ channel, action, kind, externalId, ...describeSent(payload) });
    say(`${action} on ${channel} (${kind}): ${externalId}`);
    return { externalId, url: `https://example.invalid/${channel}/${externalId}` };
  };
}

/** The issue's language, from the campaign name the engine gives it (`claudio v1 (en)`) */
const issueLanguage = (campaign: BrevoCampaign) => /\((en|es)\)$/.exec(campaign.name)?.[1] ?? 'en';

/**
 * Every built-in channel's publisher. Mastodon and Reddit answer the way their networks do when a
 * worker asks again after a lost answer: Mastodon keeps an idempotency key's post, Reddit finds the
 * submission, both from the ledger, so a repeated run shows up there as a duplicate only when the
 * real network would have posted twice too.
 */
export function fakePublishers(options: PreviewWorldOptions): Required<Publishers> {
  const send = sender(options);
  const post = (channel: string) => ({ publish: (p: unknown) => send(channel, 'publish', 'post', p) });
  return {
    devto: post('devto'),
    hashnode: post('hashnode'),
    bluesky: post('bluesky'),
    telegram: post('telegram'),
    discord: post('discord'),
    githubDiscussions: post('githubDiscussions'),
    threads: post('threads'),
    linkedin: post('linkedin'),
    mastodon: {
      async publish(p) {
        const kept = await options.ledger.find('mastodon', 'post', `"idempotencyKey":${JSON.stringify(p.idempotencyKey)}`);
        if (kept?.externalId) return { externalId: kept.externalId, url: `https://example.invalid/mastodon/${kept.externalId}` };
        // The key first, so the ledger's search finds it however long the text is
        const { idempotencyKey, ...rest } = p;
        return send('mastodon', 'publish', 'post', { idempotencyKey, ...rest });
      },
    },
    instagram: {
      publish: (p) => send('instagram', 'publish', 'post', p),
      publishStory: (m) => send('instagram', 'publish', 'story', m),
      comment: async (mediaId, message) => ({ id: (await send('instagram', 'publish', 'comment', { mediaId, message })).externalId }),
    },
    newsletter: {
      // Someone is on every list, so a scheduled issue goes out (to the ledger) instead of failing for want of readers
      subscribers: async () => 1,
      send: (campaign) => send('newsletter', 'publish', `issue:${issueLanguage(campaign)}`, { subject: campaign.subject, name: campaign.name, previewText: campaign.previewText, listId: campaign.listId, html: campaign.html }),
    },
    reddit: {
      publish: ({ subreddit, title, text }) => send('reddit', 'publish', redditKind(subreddit), { subreddit, title, text }),
      async find({ subreddit, title }) {
        const found = await options.ledger.find('reddit', redditKind(subreddit), `"title":${JSON.stringify(title)}`);
        return found?.externalId ? { externalId: found.externalId, url: `https://example.invalid/reddit/${found.externalId}` } : undefined;
      },
    },
  };
}

/**
 * The publishers of the channels that publish through their adapter's strategy, by channel. The
 * strategy itself is the real one (YouTube's renders its videos on the worker, as production does);
 * only the upload is faked.
 */
export const FAKE_STRATEGY_PUBLISHERS: Readonly<Record<string, (send: Send) => unknown>> = {
  youtube: (send): YouTubePublisher => ({
    async publish(video: YouTubeVideo): Promise<YouTubePublished> {
      const { bytes, thumbnail, ...rest } = video;
      const sent = await send('youtube', 'publish', video.short ? 'post:short' : 'post:video', { ...rest, bytes, ...(thumbnail && { thumbnail: { mimeType: thumbnail.mimeType, bytes: thumbnail.bytes } }) });
      return { ...sent, privacy: video.privacy ?? 'public', extras: [] };
    },
  }),
};

/** Every adapter's strategy bound to its fake publisher; a strategy without one is left out, so it publishes nothing */
export function fakeStrategies(options: PreviewWorldOptions): Record<string, ChannelPublishing> {
  const send = sender(options);
  const strategies: Record<string, ChannelPublishing> = {};
  for (const adapter of options.adapters ?? CHANNEL_ADAPTERS) {
    const fake = FAKE_STRATEGY_PUBLISHERS[adapter.definition.id];
    if (adapter.strategy && fake) strategies[adapter.definition.id] = bindStrategy(adapter.strategy, fake(send));
  }
  return strategies;
}

/** Every channel's editor and deleter, whatever account a piece went out with */
export function fakeEditors(options: PreviewWorldOptions): EditDeps['editors'] {
  const send = sender(options);
  const edit = (channel: string) => async (id: string, change: unknown) => void (await send(channel, 'edit', id, change));
  const remove = (channel: string) => async (id: string) => void (await send(channel, 'delete', id, { id }));
  const both = (channel: string) => ({ edit: edit(channel), delete: remove(channel) });
  const editors: Required<Editors> = {
    mastodon: both('mastodon'),
    telegram: both('telegram'),
    discord: both('discord'),
    devto: both('devto'),
    hashnode: both('hashnode'),
    githubDiscussions: both('githubDiscussions'),
    bluesky: { delete: remove('bluesky') },
    threads: { delete: remove('threads') },
    linkedin: { delete: remove('linkedin') },
    reddit: { delete: remove('reddit') },
  };
  // The channels that edit through their adapter (ChangeEditor) rather than one of Editors' typed slots
  const extra: Record<string, ChangeEditor> = {};
  for (const adapter of options.adapters ?? CHANNEL_ADAPTERS) {
    if (adapter.editor && !(adapter.definition.id in editors)) extra[adapter.definition.id] = both(adapter.definition.id);
  }
  return async () => ({ ...editors, ...extra }) as Editors;
}

/** The owner's notices, kept in the ledger instead of reaching their Telegram */
export function fakeNotifier(options: PreviewWorldOptions): Notifier {
  const send = sender(options);
  return { notify: async (text) => void (await send('telegram', 'notify', 'notice', { text })) };
}

/**
 * The safety net under everything else a preview runs (account syncs, the comment assistant's
 * replies, token refreshes): a read goes through (from the fixtures first), and any request that
 * would change something is answered with an empty success instead of leaving the machine. A
 * connector that needs a real answer then fails, which is the safe way round.
 */
export function previewNetworkFetch(options: Pick<PreviewWorldOptions, 'fixtures' | 'fetch'> = {}): typeof fetch {
  const reads = withSiteFixtures(options.fixtures, options.fetch ?? ((input, init) => fetch(input, init)));
  return async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method === 'GET' || method === 'HEAD') return reads(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    say(`would ${method} ${url.origin}${url.pathname}`);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

/** The code a preview's own consent page hands back: no network ever issued it */
export const PREVIEW_OAUTH_CODE = 'preview-fake-consent';

/**
 * A network's sign-in on a preview: the consent page is skipped (the redirect goes straight back to
 * the app's own callback, carrying the state, so a flow started on one replica still finishes on
 * whichever the browser reaches), the code is exchanged for a made-up token, and the account's check
 * answers yes. The account and its secret are written as a real sign-in writes them.
 */
export interface PreviewOAuth {
  authorizeUrl(publicUrl: string, network: string, state: string): string;
  exchange(network: string, code: string, label: string | undefined): Promise<{ label: string; credentials: Credentials }>;
  check(network: string, credentials: Credentials): Promise<Check>;
}

function previewOAuth(options: PreviewWorldOptions): PreviewOAuth {
  const send = sender(options);
  return {
    authorizeUrl: (publicUrl, network, state) => `${publicUrl}/auth/${network}/callback?${new URLSearchParams({ code: PREVIEW_OAUTH_CODE, state })}`,
    async exchange(network, code, label) {
      if (code !== PREVIEW_OAUTH_CODE) throw new Error(`${network}: this preview only takes its own consent's code`);
      const name = label?.trim() || `preview-${network}`;
      await send(network, 'connect', 'account', { label: name });
      return { label: name, credentials: { settings: { preview: 'true', label: name }, secrets: { accessToken: `preview-${randomUUID()}` } } };
    },
    check: async (_network, credentials) => ({ ok: true, account: credentials.settings.label ?? 'preview' }),
  };
}

export interface PreviewWorld {
  ledger: FakeNetworkLedger;
  fixtures: PreviewFixtures | undefined;
  /** The fetch every connector and the site's reads get on a preview */
  fetch: typeof fetch;
  editors: EditDeps['editors'];
  notifier: Notifier;
  oauth: PreviewOAuth;
  /** The real services with every part that writes to a network replaced */
  services(real: Services): Services;
}

export function previewWorld(options: PreviewWorldOptions): PreviewWorld {
  const fetch = previewNetworkFetch(options);
  const notifier = fakeNotifier(options);
  return {
    ledger: options.ledger,
    fixtures: options.fixtures,
    fetch,
    editors: fakeEditors(options),
    notifier,
    oauth: previewOAuth(options),
    services: (real) => ({
      ...real,
      publishers: fakePublishers(options),
      strategies: fakeStrategies(options),
      notifier,
      // A token refresh is a call to the network; Search Console's ping too
      instagram: undefined,
      sources: { ...real.sources, search: undefined },
      // The site's reads (the article live, the launch image) from the fixtures first
      fetch,
    }),
  };
}

/** The fake networks' latency from the environment: SHIPCAST_PREVIEW_FAKE_LATENCY_MS, none by default */
export function fakeLatencyMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.SHIPCAST_PREVIEW_FAKE_LATENCY_MS ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 120_000) : 0;
}
