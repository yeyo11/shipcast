import { youtubeFeed } from './feeds.ts';
import { ConnectorError, exchangeYouTubeCode, PostGone, YouTube, youtubeAuthorizeUrl, youtubeBucketOf, YOUTUBE_DAILY_UNITS, YOUTUBE_DAILY_UPLOADS, YOUTUBE_UNITS, type YouTubeCall, type YouTubeVideo } from '@shipcast/connectors';
import { batchReader, youtubeStrategy, type ChangeEditor, type YouTubePublisher } from '@shipcast/engine';
import { LIMITS, trackWithinLimit, youtube } from '@shipcast/schema';
import { MemoryTokenBucket } from '../redis/memory.ts';
import type { BucketSpec, TokenBucket } from '../redis/ports.ts';
import { channelAdapter, type Credentials, type OAuthApp } from './adapter.ts';

/*
 * YouTube's adapter half: the owner's OAuth client (its id and secret in Settings) and the refresh
 * token its consent gave, kept with the account since a token is only good with its client; the
 * project's daily quota kept in a per-provider budget; and its connector wired as the publisher of
 * the two videos, their editor, their numbers in batches and their comments.
 */

/** The budgets' names in the shared token buckets (redis/state.ts): the shared units, and the uploads */
export const YOUTUBE_PROVIDER = 'youtube';
export const YOUTUBE_UPLOADS_PROVIDER = 'youtube-uploads';

/**
 * The project's 10,000 units a day as a bucket that refills over the day. Google resets the count at
 * midnight Pacific; a bucket refilling as the day goes is the safe side of that, never the other.
 * Give it to the shared state's buckets for every replica to count against the one quota.
 */
export const YOUTUBE_BUCKET: BucketSpec = { capacity: YOUTUBE_DAILY_UNITS, refillPerSecond: YOUTUBE_DAILY_UNITS / 86_400 };
/** The 100 uploads a day `videos.insert` has to itself, the same way */
export const YOUTUBE_UPLOADS_BUCKET: BucketSpec = { capacity: YOUTUBE_DAILY_UPLOADS, refillPerSecond: YOUTUBE_DAILY_UPLOADS / 86_400 };

/** This process's count when no shared bucket is given: a single install, where one process is all of them */
const LOCAL_BUCKET = new MemoryTokenBucket({ [YOUTUBE_PROVIDER]: YOUTUBE_BUCKET, [YOUTUBE_UPLOADS_PROVIDER]: YOUTUBE_UPLOADS_BUCKET });

/** What an upload costs of the day's shared units: each caption track and the thumbnail (the upload itself is in its own bucket) */
export function uploadUnits(video: Pick<YouTubeVideo, 'captions' | 'thumbnail'>): number {
  return (video.captions?.length ?? 0) * YOUTUBE_UNITS.captionsInsert + (video.thumbnail ? YOUTUBE_UNITS.thumbnailsSet : 0);
}

/**
 * The day's YouTube quotas: every call's units are spent as the connector reports them, in the bucket
 * Google charges it to, and an upload the day cannot pay for in full (one of the day's uploads, and
 * the units of its captions and thumbnail) is refused before it starts, since one cut short by the
 * quota would leave a video without its captions or thumbnail.
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

  /** Uploads left today */
  async uploadsLeft(): Promise<number> {
    return Math.floor((await this.#bucket.take(YOUTUBE_UPLOADS_PROVIDER, 0)).remaining);
  }

  /** Counts what a call spent, in its bucket; a call the bucket could not pay for in full leaves it empty */
  async spend(units: number, call: YouTubeCall = 'list'): Promise<void> {
    const provider = youtubeBucketOf(call) === 'uploads' ? YOUTUBE_UPLOADS_PROVIDER : YOUTUBE_PROVIDER;
    const taken = await this.#bucket.take(provider, units);
    if (!taken.ok) await this.#bucket.observe(provider, { remaining: 0 });
  }

  /** Refuses an upload today's quotas cannot pay for; retried on a later round, when the day has refilled them */
  async ensureUpload(video: Pick<YouTubeVideo, 'captions' | 'thumbnail'>): Promise<void> {
    const uploads = await this.uploadsLeft();
    if (uploads < YOUTUBE_UNITS.insert) throw new ConnectorError('YouTube', `today's quota has no upload left: ${YOUTUBE_DAILY_UPLOADS} a day`, 429, true);
    const units = uploadUnits(video);
    const left = await this.left();
    if (left < units) throw new ConnectorError('YouTube', `today's quota cannot pay for an upload's captions and thumbnail: they cost ${units} units and ${left} are left of ${YOUTUBE_DAILY_UNITS}`, 429, true);
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
        'Reads the videos’ views, likes and comments, the channel’s subscribers and its description, keywords, country and trailer (youtube.readonly)',
        'Changes the channel’s description, keywords, country and trailer when you apply a profile proposal (youtube.force-ssl)',
        'Reads each video’s watch time, engaged views, shares and subscribers gained once a day (yt-analytics.readonly)',
      ],
      howTo:
        'Needs your Google Cloud project with the YouTube Data API v3 and the YouTube Analytics API on, and an OAuth client (Web application) whose redirect URI is this app’s /auth/youtube/callback, its client id and secret set in Settings. Shipcast sends you to Google to authorise it once. Publish the consent screen (In production): while it is in Testing, Google ends the sign-in after 7 days and YouTube has to be connected again.',
      oauth: {
        app: { term: 'client', name: 'YouTube' },
        authorizeUrl: (app, redirectUri, state) => youtubeAuthorizeUrl(app.clientId, redirectUri, state),
        exchange: async (app, redirectUri, code, http) => ({ credentials: youtubeCredentials(app, (await exchangeYouTubeCode(app, redirectUri, code, http)).refreshToken) }),
        errorParams: ['error_description', 'error'],
      },
      build: ({ need, fetch, buckets, cache }) => {
        const quota = new YouTubeQuota(buckets);
        // A failed count never fails the call it counts: the quota is a guard, not the work
        const onUnits = (units: number, call: YouTubeCall) => void quota.spend(units, call).catch(() => undefined);
        const connector = new YouTube({ clientId: need('clientId'), clientSecret: need('clientSecret'), refreshToken: need('refreshToken'), onUnits, ...(fetch && { fetch }), ...(cache && { cache }) });
        return { connector: { youtube: connector, quota }, check: () => connector.check(), profileStats: () => connector.stats(), profile: () => connector.profile(), editProfile: (e) => connector.editProfile(e) };
      },
    },
  },
  publisher: ({ youtube: connector, quota }: YouTubeConnection): YouTubePublisher => ({
    // The description's links say which of the two videos the visit came from; a description the
    // tags would push over YouTube's limit keeps its `?ref=youtube`
    publish: async (video, tracking) => {
      await quota.ensureUpload(video);
      const description = trackWithinLimit('youtube', video.description, tracking, { content: video.short ? 'short' : 'video', max: LIMITS.youtubeDescription });
      return connector.publish({ ...video, description });
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
    // Watch time, engaged views and shares, once a day (the definition's analytics cadence)
    analytics: (pieces: ReadonlyArray<{ id: string; since: string }>, until: string) => connector.analytics(pieces, until),
    read: batchReader((ids) => connector.metrics(ids)).read,
    metrics: async (id: string) => {
      const values = (await connector.metrics([id])).get(id);
      if (!values) throw new PostGone('YouTube', `the video ${id} is not on the channel any more`, 404);
      return values;
    },
  }),
  comments: ({ youtube: connector }: YouTubeConnection) => ({ reader: connector, replier: connector, feed: youtubeFeed(connector) }),
});
