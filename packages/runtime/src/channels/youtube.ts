import { ConnectorError, exchangeYouTubeCode, PostGone, YouTube, youtubeAuthorizeUrl, YOUTUBE_DAILY_UNITS, YOUTUBE_UNITS, type YouTubeVideo } from '@shipcast/connectors';
import { youtubeStrategy, type ChangeEditor, type YouTubePublisher } from '@shipcast/engine';
import { youtube } from '@shipcast/schema';
import { MemoryTokenBucket } from '../redis/memory.ts';
import type { BucketSpec, TokenBucket } from '../redis/ports.ts';
import { channelAdapter, type Credentials, type OAuthApp } from './adapter.ts';

/*
 * YouTube's adapter half: the owner's OAuth client (its id and secret in Settings) and the refresh
 * token its consent gave, kept with the account since a token is only good with its client; the
 * project's daily quota kept in a per-provider budget; and its connector wired as the publisher of
 * the two videos, their editor, their numbers in batches and their comments.
 */

/** The budget's name in the shared token buckets (redis/state.ts) */
export const YOUTUBE_PROVIDER = 'youtube';

/**
 * The project's 10,000 units a day as a bucket that refills over the day. Google resets the count at
 * midnight Pacific; a bucket refilling as the day goes is the safe side of that, never the other.
 * Give it to the shared state's buckets for every replica to count against the one quota.
 */
export const YOUTUBE_BUCKET: BucketSpec = { capacity: YOUTUBE_DAILY_UNITS, refillPerSecond: YOUTUBE_DAILY_UNITS / 86_400 };

/** This process's count when no shared bucket is given: a single install, where one process is all of them */
const LOCAL_BUCKET = new MemoryTokenBucket({ [YOUTUBE_PROVIDER]: YOUTUBE_BUCKET });

/** What an upload costs of the day's quota: the upload, each caption track, the thumbnail */
export function uploadUnits(video: Pick<YouTubeVideo, 'captions' | 'thumbnail'>): number {
  return YOUTUBE_UNITS.insert + (video.captions?.length ?? 0) * YOUTUBE_UNITS.captionsInsert + (video.thumbnail ? YOUTUBE_UNITS.thumbnailsSet : 0);
}

/**
 * The day's YouTube quota: every call's units are spent as the connector reports them, and an upload
 * the day cannot pay for in full is refused before it starts, since one cut short by the quota would
 * leave a video without its captions or thumbnail.
 */
export class YouTubeQuota {
  readonly #bucket: TokenBucket;

  constructor(bucket: TokenBucket = LOCAL_BUCKET) {
    this.#bucket = bucket;
  }

  /** Units left today, as far as Shipcast has spent them */
  async left(): Promise<number> {
    return Math.floor((await this.#bucket.take(YOUTUBE_PROVIDER, 0)).remaining);
  }

  /** Counts what a call spent; a call the bucket could not pay for in full leaves it empty */
  async spend(units: number): Promise<void> {
    const taken = await this.#bucket.take(YOUTUBE_PROVIDER, units);
    if (!taken.ok) await this.#bucket.observe(YOUTUBE_PROVIDER, { remaining: 0 });
  }

  /** Refuses what today's quota cannot pay for; retried on a later round, when the day has refilled it */
  async ensure(units: number, what: string): Promise<void> {
    const left = await this.left();
    if (left < units) throw new ConnectorError('YouTube', `today's quota cannot pay for ${what}: it costs ${units} units and ${left} are left of ${YOUTUBE_DAILY_UNITS}`, 429, true);
  }
}

/** What the adapter builds: the connector and the quota its calls are counted against */
export interface YouTubeConnection {
  youtube: YouTube;
  quota: YouTubeQuota;
}

/**
 * The account's credentials from the client and a refresh token, the same whether the token came
 * from the sign-in's callback or from a file imported once (`shipcast youtube import`)
 */
export function youtubeCredentials(app: OAuthApp, refreshToken: string): Credentials {
  return { settings: { clientId: app.clientId }, secrets: { clientSecret: app.clientSecret, refreshToken } };
}

export const youtubeAdapter = channelAdapter({
  definition: youtube,
  connect: {
    kind: 'account',
    network: {
      id: 'youtube',
      auth: 'oauth',
      fields: [],
      permissions: [
        'Uploads the launch’s two videos, a Short and a horizontal one, with captions and the cover as the thumbnail (youtube.upload)',
        'Changes a video’s title, description and tags, deletes it, and answers its comments when you approve (youtube.force-ssl)',
        'Reads the videos’ views, likes and comments and the channel’s subscribers (youtube.readonly)',
        'Google keeps the uploads of a project it has not audited private: they are listed as private until it does',
      ],
      howTo:
        'Needs your Google Cloud project with the YouTube Data API v3 on, its consent screen published, and an OAuth client (Web application) whose redirect URI is this app’s /auth/youtube/callback, its client id and secret set in Settings. Shipcast sends you to Google to authorise it once; the account stays connected.',
      oauth: {
        app: { term: 'client', name: 'YouTube' },
        authorizeUrl: (app, redirectUri, state) => youtubeAuthorizeUrl(app.clientId, redirectUri, state),
        exchange: async (app, redirectUri, code, http) => ({ credentials: youtubeCredentials(app, (await exchangeYouTubeCode(app, redirectUri, code, http)).refreshToken) }),
        errorParams: ['error_description', 'error'],
      },
      build: ({ need, fetch, buckets }) => {
        const quota = new YouTubeQuota(buckets);
        // A failed count never fails the call it counts: the quota is a guard, not the work
        const onUnits = (units: number) => void quota.spend(units).catch(() => undefined);
        const connector = new YouTube({ clientId: need('clientId'), clientSecret: need('clientSecret'), refreshToken: need('refreshToken'), onUnits, ...(fetch && { fetch }) });
        return { connector: { youtube: connector, quota }, check: () => connector.check(), profileStats: () => connector.stats() };
      },
    },
  },
  publisher: ({ youtube: connector, quota }: YouTubeConnection): YouTubePublisher => ({
    publish: async (video) => {
      await quota.ensure(uploadUnits(video), 'an upload');
      return connector.publish(video);
    },
  }),
  strategy: youtubeStrategy(),
  editor: ({ youtube: connector }: YouTubeConnection): ChangeEditor => ({
    // The description is the post's text; the title and tags are the video's own
    edit: (id, changes) =>
      connector.edit(id, { ...(changes.title !== undefined && { title: changes.title }), ...(changes.text !== undefined && { description: changes.text }), ...(changes.tags !== undefined && { tags: changes.tags }) }),
    delete: (id) => connector.delete(id),
  }),
  metrics: ({ youtube: connector }: YouTubeConnection) => ({
    metricsMany: (ids: string[]) => connector.metrics(ids),
    metrics: async (id: string) => {
      const values = (await connector.metrics([id])).get(id);
      if (!values) throw new PostGone('YouTube', `the video ${id} is not on the channel any more`, 404);
      return values;
    },
  }),
  comments: ({ youtube: connector }: YouTubeConnection) => ({ reader: connector, replier: connector }),
});
