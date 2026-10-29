import { HttpClient } from './http-client.ts';
import { checkProblem, ConnectorError, secretTag, type IdentityCache, imageUrl, okCheck, PostGone, statsOf, type Check, type Comment, type CommentReader, type Deletable, type Metrics, type Profile, type ProfileEdit, type ProfileEditor, type ProfileLink, type ProfileReader, type ProfileStats, type Published, type Replier, type ReplyTarget, type SentReply } from './http.ts';

/** The YouTube Analytics scope: watch time, engaged views and shares of the channel's own videos */
export const YOUTUBE_ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/yt-analytics.readonly';

/**
 * The scopes Shipcast asks YouTube for: uploading, reading the channel's own data, managing its
 * videos, captions, comments and channel settings, and its analytics. An account connected before
 * the analytics scope was asked for keeps working; only its analytics are not read
 */
export const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/youtube.force-ssl', YOUTUBE_ANALYTICS_SCOPE];

/**
 * What the YouTube Analytics API is asked for per video, and the names Shipcast keeps them under.
 * Lifetime-to-date from the launch's day: Google's numbers lag 48 to 72 hours behind the public counters.
 * The averages are not counters: they are kept as read, never summed.
 */
export const YOUTUBE_ANALYTICS_METRICS = {
  engagedViews: 'engagedViews',
  estimatedMinutesWatched: 'watchMinutes',
  averageViewDuration: 'avgViewSeconds',
  averageViewPercentage: 'avgViewPercent',
  shares: 'shares',
  subscribersGained: 'subscribersGained',
} as const;

/**
 * What each call costs, as Google's quota calculator lists it (read 2026-10-29). Every call but an
 * upload is charged to the project's 10,000 units a day; since 2026-06-01 `videos.insert` has a
 * bucket of its own, 100 calls a day at one unit each (it cost about 1,600 units of the shared
 * quota until 2025-12-04, then about 100). The caller counts units (`onUnits`) per bucket
 * (`youtubeBucketOf`), and the per-provider limiter refuses an upload the day cannot pay for.
 */
export const YOUTUBE_UNITS = {
  list: 1,
  insert: 1,
  update: 50,
  delete: 50,
  captionsInsert: 400,
  thumbnailsSet: 50,
  commentsInsert: 50,
  channelsUpdate: 50,
} as const;

export type YouTubeCall = keyof typeof YOUTUBE_UNITS;

/** The project's daily units for every call but an upload, when Google has not raised them */
export const YOUTUBE_DAILY_UNITS = 10_000;
/** The uploads the project may make a day, in the bucket `videos.insert` has to itself */
export const YOUTUBE_DAILY_UPLOADS = 100;

/** Which of the project's two daily quotas a call is charged to */
export const youtubeBucketOf = (call: YouTubeCall): 'uploads' | 'units' => (call === 'insert' ? 'uploads' : 'units');

export interface YouTubeOptions {
  /** The OAuth client the refresh token was issued to: a token is only good with its client */
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: typeof fetch;
  /** Told the quota units each call spends, so the day's spend can be counted and capped */
  onUnits?: (units: number, call: YouTubeCall) => void;
  /** Where the channel's id is kept between runs, so the hourly reads do not ask for it each time */
  cache?: IdentityCache;
}

export interface YouTubeVideo {
  title: string;
  description: string;
  tags: string[];
  /** BCP 47, the language the title and description are written in */
  lang: string;
  /** The video file, MP4 */
  bytes: Uint8Array;
  /** A Short is a vertical video under a minute; its address is /shorts/<id> */
  short: boolean;
  /** What Shipcast asks for; Google no longer forces an unverified project's uploads to private, but the answer says what it set */
  privacy?: 'public' | 'unlisted' | 'private';
  /** Captions to upload beside the burned-in subtitles, one track per language */
  captions?: Array<{ lang: string; name: string; srt: string }>;
  /** A custom thumbnail, JPEG or PNG; only a verified channel may set one */
  thumbnail?: { bytes: Uint8Array; mimeType: string };
}

export interface YouTubePublished extends Published {
  /** The privacy the video has after the upload: `private` when Google keeps it so */
  privacy: string;
  /** What did not go up beside the video, in words: a caption track, the thumbnail */
  extras: string[];
}

export interface YouTubeEdit {
  title?: string;
  description?: string;
  tags?: string[];
}

const API = 'https://www.googleapis.com/youtube/v3';
const ANALYTICS = 'https://youtubeanalytics.googleapis.com/v2/reports';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3';
const TOKEN = 'https://oauth2.googleapis.com/token';
/** Science & Technology: YouTube asks every video for a category, and a launch is that */
const CATEGORY = '28';

interface VideoResource {
  id: string;
  snippet?: { title?: string; description?: string; tags?: string[]; categoryId?: string; defaultLanguage?: string };
  status?: { privacyStatus?: string; uploadStatus?: string; rejectionReason?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string; favoriteCount?: string };
}

interface CommentThread {
  id: string;
  snippet: {
    videoId?: string;
    topLevelComment: { id: string; snippet: CommentSnippet };
  };
  replies?: { comments: Array<{ id: string; snippet: CommentSnippet }> };
}

interface CommentSnippet {
  textOriginal?: string;
  textDisplay?: string;
  authorDisplayName?: string;
  authorProfileImageUrl?: string;
  authorChannelId?: { value?: string };
  publishedAt: string;
  updatedAt?: string;
  parentId?: string;
}

interface ChannelBranding {
  channel?: { title?: string; description?: string; keywords?: string; country?: string; unsubscribedTrailer?: string; defaultLanguage?: string; [key: string]: unknown };
  image?: { bannerExternalUrl?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** What a channel edit can change, through `brandingSettings`: what is left out stays as it is */
export interface YouTubeChannelEdit {
  description?: string;
  /** Space-separated, a phrase of several words in double quotes, as YouTube Studio writes them */
  keywords?: string;
  /** ISO 3166-1 alpha-2 */
  country?: string;
  /** A video of the channel's own, by its id or address, played to visitors who have not subscribed */
  trailer?: string;
}

/**
 * The channel's settings that have no field of their own in a profile, read and written as its
 * links: one `Label: value` line each, so a review can see and propose them like any link
 */
const SETTING_LINKS = { Keywords: 'keywords', Country: 'country', Trailer: 'trailer' } as const satisfies Record<string, keyof YouTubeChannelEdit>;

/** A video's id from its id or any of its addresses (watch, youtu.be, shorts) */
export function youtubeVideoId(value: string): string {
  const text = value.trim();
  try {
    const url = new URL(text);
    if (url.hostname === 'youtu.be') return url.pathname.slice(1);
    return url.searchParams.get('v') ?? url.pathname.split('/').filter(Boolean).at(-1) ?? text;
  } catch {
    return text;
  }
}

const count = (value: string | undefined) => (value === undefined ? undefined : Number(value));

/**
 * YouTube, as the owner's channel through their OAuth client (a refresh token, offline access):
 * resumable uploads with caption tracks and a thumbnail, edits of the title, description and tags,
 * deletes, the videos' numbers read 50 at a time, the channel's own numbers, and the comments under
 * a video read and answered. Every call goes through one HttpClient (timeouts, retries of what is
 * safe to repeat, counted by the process's telemetry) and reports its quota units.
 */
export class YouTube implements Deletable, CommentReader, Replier, ProfileReader, ProfileEditor {
  readonly #options: YouTubeOptions;
  readonly #http: HttpClient;
  #token: Promise<string> | undefined;
  #channelId: Promise<string> | undefined;

  constructor(options: YouTubeOptions) {
    this.#options = options;
    this.#http = new HttpClient({ network: 'YouTube', ...(options.fetch && { fetch: options.fetch }), timeoutMs: 60_000 });
  }

  #units(call: YouTubeCall): void {
    this.#options.onUnits?.(YOUTUBE_UNITS[call], call);
  }

  /** An access token for this connector's life: one refresh, since a token lasts an hour */
  #accessToken(): Promise<string> {
    this.#token ??= (async () => {
      const response = await this.#http.request(TOKEN, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: this.#options.clientId, client_secret: this.#options.clientSecret, refresh_token: this.#options.refreshToken }),
        // Trading a refresh token twice is harmless: it is not consumed
        retry: true,
        what: 'refresh the token',
      });
      const body = (await response.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
      if (response.ok && body.access_token) return body.access_token;
      // invalid_grant: revoked, or expired (a consent screen left in Testing ends a token after 7 days)
      if (body.error === 'invalid_grant') throw new ConnectorError('YouTube', 'the token was refused (expired or revoked): connect YouTube again from Channels', 401, false);
      throw new ConnectorError('YouTube', `refresh the token: ${response.status} ${body.error ?? ''} ${body.error_description ?? ''}`.trim(), response.status);
    })();
    this.#token.catch(() => (this.#token = undefined));
    return this.#token;
  }

  async #auth(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.#accessToken()}` };
  }

  /** The channel the token belongs to: whose comments are the owner's own */
  #ownChannel(): Promise<string> {
    const load = async () => {
      this.#units('list');
      const answer = await this.#http.json<{ items?: Array<{ id: string }> }>(`${API}/channels?part=id&mine=true`, { headers: await this.#auth(), what: 'read the channel' });
      const id = answer.items?.[0]?.id;
      if (!id) throw new ConnectorError('YouTube', 'this Google account has no YouTube channel: create one, then connect again', 404, false);
      return id;
    };
    const cache = this.#options.cache;
    this.#channelId ??= cache ? cache.remember(`youtube-channel:${secretTag(this.#options.refreshToken)}`, 86_400, load) : load();
    this.#channelId.catch(() => (this.#channelId = undefined));
    return this.#channelId;
  }

  async check(): Promise<Check> {
    try {
      this.#units('list');
      const answer = await this.#http.json<{ items?: Array<{ snippet?: { title?: string; customUrl?: string; thumbnails?: { default?: { url?: string } } } }> }>(`${API}/channels?part=snippet&mine=true`, {
        headers: await this.#auth(),
        what: 'read the channel',
      });
      const snippet = answer.items?.[0]?.snippet;
      if (!snippet) return { ok: false, problem: 'this Google account has no YouTube channel' };
      return okCheck(snippet.customUrl ?? snippet.title ?? 'YouTube', { displayName: snippet.title, avatarUrl: snippet.thumbnails?.default?.url });
    } catch (error) {
      return checkProblem(error, 'YouTube refused the token: connect it again, with the upload, read and manage permissions');
    }
  }

  /**
   * Uploads a video in one resumable session: the metadata first (which answers the address to send
   * the bytes to), then the bytes. The session's POST is not repeated on a lost answer: a second one
   * would make a second video. Captions and the thumbnail follow; one of them failing is reported in
   * `extras` and never undoes the video, which is out.
   */
  async publish(video: YouTubeVideo): Promise<YouTubePublished> {
    const metadata = {
      snippet: { title: video.title, description: video.description, tags: video.tags, categoryId: CATEGORY, defaultLanguage: video.lang, defaultAudioLanguage: video.lang },
      status: { privacyStatus: video.privacy ?? 'public', selfDeclaredMadeForKids: false },
    };
    this.#units('insert');
    const session = await this.#http.request(`${UPLOAD}/videos?uploadType=resumable&part=snippet,status`, {
      method: 'POST',
      headers: { ...(await this.#auth()), 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'video/mp4', 'x-upload-content-length': String(video.bytes.byteLength) },
      body: JSON.stringify(metadata),
      what: 'start the upload',
    });
    const location = session.headers.get('location');
    if (!session.ok || !location) {
      const text = await session.text().catch(() => '');
      throw new ConnectorError('YouTube', `start the upload: ${session.status} ${text.slice(0, 300)}`, session.status);
    }
    // The bytes to the session's address; a PUT to it is safe to repeat (it resumes the same video)
    const uploaded = await this.#http.json<VideoResource>(location, {
      method: 'PUT',
      headers: { 'content-type': 'video/mp4' },
      body: video.bytes as Uint8Array<ArrayBuffer>,
      retry: true,
      timeoutMs: 15 * 60_000,
      what: 'upload the video',
    });
    const extras: string[] = [];
    for (const track of video.captions ?? []) {
      await this.#caption(uploaded.id, track).catch((error: unknown) => extras.push(`captions (${track.lang}): ${error instanceof Error ? error.message : String(error)}`));
    }
    if (video.thumbnail) {
      await this.#thumbnail(uploaded.id, video.thumbnail).catch((error: unknown) => extras.push(`thumbnail: ${error instanceof Error ? error.message : String(error)}`));
    }
    return {
      externalId: uploaded.id,
      url: video.short ? `https://www.youtube.com/shorts/${uploaded.id}` : `https://www.youtube.com/watch?v=${uploaded.id}`,
      privacy: uploaded.status?.privacyStatus ?? metadata.status.privacyStatus,
      extras,
    };
  }

  /** One caption track, as a multipart upload of its metadata and the SRT */
  async #caption(videoId: string, track: { lang: string; name: string; srt: string }): Promise<void> {
    const boundary = `shipcast-${videoId}-${track.lang}`;
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify({ snippet: { videoId, language: track.lang, name: track.name, isDraft: false } }),
      `--${boundary}`,
      'Content-Type: application/x-subrip; charset=UTF-8',
      '',
      track.srt,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    this.#units('captionsInsert');
    await this.#http.ok(`${UPLOAD}/captions?uploadType=multipart&part=snippet`, {
      method: 'POST',
      headers: { ...(await this.#auth()), 'content-type': `multipart/related; boundary=${boundary}` },
      body,
      what: 'upload the captions',
    });
  }

  async #thumbnail(videoId: string, image: { bytes: Uint8Array; mimeType: string }): Promise<void> {
    this.#units('thumbnailsSet');
    try {
      await this.#http.ok(`${UPLOAD}/thumbnails/set?videoId=${encodeURIComponent(videoId)}`, { method: 'POST', headers: { ...(await this.#auth()), 'content-type': image.mimeType }, body: image.bytes as Uint8Array<ArrayBuffer>, retry: true, what: 'set the thumbnail' });
    } catch (error) {
      // A channel that is not verified may not set a custom thumbnail: said plainly, not as a status code
      if (error instanceof ConnectorError && error.status === 403) throw new ConnectorError('YouTube', 'a custom thumbnail needs a verified channel (YouTube Studio, Settings, Channel, Feature eligibility)', 403, false);
      throw error;
    }
  }

  /** The video's resource, or PostGone when it is no longer there */
  async #video(id: string, part: string): Promise<VideoResource> {
    this.#units('list');
    const answer = await this.#http.json<{ items?: VideoResource[] }>(`${API}/videos?part=${part}&id=${encodeURIComponent(id)}`, { headers: await this.#auth(), what: 'read the video' });
    const video = answer.items?.[0];
    if (!video) throw new PostGone('YouTube', `the video ${id} is not on the channel any more`, 404);
    return video;
  }

  /**
   * Changes a video's title, description or tags. YouTube replaces the whole snippet, so the one it
   * has is read first and only the given fields change in it (its category and language stay).
   */
  async edit(id: string, change: YouTubeEdit): Promise<void> {
    const { snippet = {} } = await this.#video(id, 'snippet');
    const next = { ...snippet, categoryId: snippet.categoryId ?? CATEGORY, ...(change.title !== undefined && { title: change.title }), ...(change.description !== undefined && { description: change.description }), ...(change.tags !== undefined && { tags: change.tags }) };
    this.#units('update');
    await this.#http.ok(`${API}/videos?part=snippet`, { method: 'PUT', headers: { ...(await this.#auth()), 'content-type': 'application/json' }, body: JSON.stringify({ id, snippet: next }), what: 'edit the video' });
  }

  async delete(id: string): Promise<void> {
    this.#units('delete');
    try {
      await this.#http.ok(`${API}/videos?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers: await this.#auth(), what: 'delete the video' });
    } catch (error) {
      // Gone already is what a delete wanted
      if (error instanceof ConnectorError && error.status === 404) return;
      throw error;
    }
  }

  /** The privacy each video has now, for the page's "private until Google audits the project" */
  async privacy(id: string): Promise<string | undefined> {
    return (await this.#video(id, 'status')).status?.privacyStatus;
  }

  /**
   * The numbers of many videos, 50 per call (one quota unit each): views, likes, comments. A video
   * missing from the answer is gone, and is left out of the result rather than read as zeros.
   */
  async metrics(ids: string[]): Promise<Map<string, Metrics>> {
    const out = new Map<string, Metrics>();
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      this.#units('list');
      const answer = await this.#http.json<{ items?: VideoResource[] }>(`${API}/videos?part=statistics&id=${batch.map(encodeURIComponent).join(',')}`, { headers: await this.#auth(), what: 'read the numbers' });
      for (const video of answer.items ?? []) {
        const s = video.statistics ?? {};
        const values: Metrics = {};
        for (const [name, value] of [['views', count(s.viewCount)], ['likes', count(s.likeCount)], ['comments', count(s.commentCount)]] as const) if (value !== undefined && Number.isFinite(value)) values[name] = value;
        out.set(video.id, values);
      }
    }
    return out;
  }

  /** The channel's own numbers: subscribers (unless hidden), videos and total views */
  async stats(): Promise<ProfileStats> {
    this.#units('list');
    const answer = await this.#http.json<{ items?: Array<{ statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean; videoCount?: string; viewCount?: string } }> }>(`${API}/channels?part=statistics&mine=true`, {
      headers: await this.#auth(),
      what: 'read the channel',
    });
    const s = answer.items?.[0]?.statistics ?? {};
    return statsOf({ followers: s.hiddenSubscriberCount ? undefined : count(s.subscriberCount), posts: count(s.videoCount) }, { views: count(s.viewCount) });
  }

  /**
   * Each video's YouTube Analytics numbers (YOUTUBE_ANALYTICS_METRICS), lifetime to date from `since`
   * to `until` (YYYY-MM-DD): one report per video, from the Analytics API's own quota rather than the
   * Data API's units. A connection made before Shipcast asked for `yt-analytics.readonly`, or a project
   * with the Analytics API off, is refused with why, once, never as a broken account: the views and
   * likes of the hourly reads are not touched.
   */
  async analytics(videos: ReadonlyArray<{ id: string; since: string }>, until: string): Promise<Map<string, Metrics>> {
    const out = new Map<string, Metrics>();
    const asked = Object.keys(YOUTUBE_ANALYTICS_METRICS);
    for (const video of videos) {
      const query = new URLSearchParams({ ids: 'channel==MINE', startDate: video.since, endDate: until, metrics: asked.join(','), filters: `video==${video.id}` });
      const response = await this.#http.request(`${ANALYTICS}?${query}`, { headers: await this.#auth(), what: 'read the analytics' });
      const text = await response.text();
      if (response.status === 403 && /SCOPE_INSUFFICIENT|insufficient authentication scopes|insufficientPermissions/i.test(text)) {
        throw new ConnectorError('YouTube', 'YouTube Analytics was not granted to this connection (yt-analytics.readonly): connect YouTube again from Channels to read watch time, engaged views and shares', 403, false);
      }
      if (response.status === 403 && /SERVICE_DISABLED|accessNotConfigured|has not been used in project/i.test(text)) {
        throw new ConnectorError('YouTube', 'the YouTube Analytics API is off in the Google Cloud project: turn it on, then the analytics are read on the next day', 403, false);
      }
      if (!response.ok) throw new ConnectorError('YouTube', `read the analytics: ${response.status} ${text.slice(0, 300)}`, response.status);
      const answer = JSON.parse(text) as { columnHeaders?: Array<{ name: string }>; rows?: number[][] };
      const row = answer.rows?.[0];
      if (!row) continue;
      const values: Metrics = {};
      (answer.columnHeaders ?? []).forEach((header, i) => {
        const name = YOUTUBE_ANALYTICS_METRICS[header.name as keyof typeof YOUTUBE_ANALYTICS_METRICS];
        const value = row[i];
        if (name && typeof value === 'number' && Number.isFinite(value)) values[name] = value;
      });
      out.set(video.id, values);
    }
    return out;
  }

  /** The channel's `brandingSettings` as YouTube has them, with the channel's id */
  async #branding(): Promise<{ id: string; branding: ChannelBranding; snippet: { title?: string; thumbnails?: { default?: { url?: string } } } }> {
    this.#units('list');
    const answer = await this.#http.json<{ items?: Array<{ id: string; brandingSettings?: ChannelBranding; snippet?: { title?: string; thumbnails?: { default?: { url?: string } } } }> }>(`${API}/channels?part=snippet,brandingSettings&mine=true`, {
      headers: await this.#auth(),
      what: 'read the channel',
    });
    const item = answer.items?.[0];
    if (!item) throw new ConnectorError('YouTube', 'this Google account has no YouTube channel: create one, then connect again', 404, false);
    return { id: item.id, branding: item.brandingSettings ?? {}, snippet: item.snippet ?? {} };
  }

  /**
   * The channel as a profile: its name, its description as the bio, and its keywords, country and
   * trailer as `Label: value` links (it has no links section the API reads). The name and the
   * picture are changed in YouTube Studio only.
   */
  async profile(): Promise<Profile> {
    const { branding, snippet } = await this.#branding();
    const channel = branding.channel ?? {};
    const links: ProfileLink[] = [
      ...(channel.keywords?.trim() ? [{ name: 'Keywords', value: channel.keywords }] : []),
      ...(channel.country ? [{ name: 'Country', value: channel.country }] : []),
      ...(channel.unsubscribedTrailer ? [{ name: 'Trailer', value: `https://www.youtube.com/watch?v=${channel.unsubscribedTrailer}` }] : []),
    ];
    const title = channel.title ?? snippet.title;
    return {
      ...(title?.trim() && { displayName: title }),
      ...(channel.description?.trim() && { bio: channel.description }),
      links,
      hasAvatar: imageUrl(snippet.thumbnails?.default?.url) !== undefined,
      hasBanner: Boolean(branding.image?.bannerExternalUrl),
    };
  }

  /**
   * Changes the channel's description, keywords, country or trailer. YouTube deletes every
   * `brandingSettings` property an update leaves out, so the whole object is read first and only the
   * given fields change in it.
   */
  async editChannel(change: YouTubeChannelEdit): Promise<void> {
    const { id, branding } = await this.#branding();
    const channel = {
      ...branding.channel,
      ...(change.description !== undefined && { description: change.description }),
      ...(change.keywords !== undefined && { keywords: change.keywords }),
      ...(change.country !== undefined && { country: change.country.trim().toUpperCase() }),
      ...(change.trailer !== undefined && { unsubscribedTrailer: youtubeVideoId(change.trailer) }),
    };
    this.#units('channelsUpdate');
    await this.#http.ok(`${API}/channels?part=brandingSettings`, { method: 'PUT', headers: { ...(await this.#auth()), 'content-type': 'application/json' }, body: JSON.stringify({ id, brandingSettings: { ...branding, channel } }), what: 'edit the channel' });
  }

  /** A profile edit as a channel edit: the bio is the description, the links its keywords, country and trailer */
  async editProfile(edit: ProfileEdit): Promise<void> {
    if (edit.displayName !== undefined) throw new ConnectorError('YouTube', 'the channel’s name is changed in YouTube Studio only', 400, false);
    const change: YouTubeChannelEdit = { ...(edit.bio !== undefined && { description: edit.bio }) };
    if (edit.links !== undefined) {
      for (const link of edit.links) {
        const field = SETTING_LINKS[link.name.trim() as keyof typeof SETTING_LINKS];
        if (!field) throw new ConnectorError('YouTube', `a channel has no "${link.name}": its links are ${Object.keys(SETTING_LINKS).join(', ')}`, 400, false);
        change[field] = link.value;
      }
      // A setting left out of the list is cleared, as a link left out is removed elsewhere
      for (const field of Object.values(SETTING_LINKS)) change[field] ??= '';
    }
    await this.editChannel(change);
  }

  /** Every comment under a video, top-level ones and their replies, as plain text */
  async comments(videoId: string): Promise<Comment[]> {
    const own = await this.#ownChannel();
    const out: Comment[] = [];
    let page: string | undefined;
    do {
      this.#units('list');
      const query = new URLSearchParams({ part: 'snippet,replies', videoId, maxResults: '100', textFormat: 'plainText', ...(page && { pageToken: page }) });
      const response = await this.#http.request(`${API}/commentThreads?${query}`, { headers: await this.#auth(), what: 'read the comments' });
      if (response.status === 404) throw new PostGone('YouTube', `the video ${videoId} is not on the channel any more`, 404);
      // Comments turned off on the video: nothing to read, which is not a failure
      if (response.status === 403 && (await response.clone().text()).includes('commentsDisabled')) return out;
      if (!response.ok) throw new ConnectorError('YouTube', `read the comments: ${response.status} ${(await response.text()).slice(0, 300)}`, response.status);
      const answer = (await response.json()) as { items?: CommentThread[]; nextPageToken?: string };
      for (const thread of answer.items ?? []) {
        const top = thread.snippet.topLevelComment;
        out.push(toComment(top.id, top.snippet, own, videoId));
        for (const reply of thread.replies?.comments ?? []) out.push(toComment(reply.id, reply.snippet, own, videoId, top.id));
      }
      page = answer.nextPageToken;
    } while (page);
    return out;
  }

  /**
   * The channel's comment threads with activity after `since`, newest first, through
   * `allThreadsRelatedToChannelId`: one call (one unit) for every video at once in a quiet hour, five
   * pages of 100 at most. Each says the video it is under and when it last moved, its replies (the
   * few the answer carries) included.
   */
  async threadsSince(since: string | undefined): Promise<{ items: Array<{ videoId: string; at: string }>; newest: string | undefined }> {
    const own = await this.#ownChannel();
    const items: Array<{ videoId: string; at: string }> = [];
    let newest = since;
    let page: string | undefined;
    for (let n = 0; n < 5; n++) {
      this.#units('list');
      const query = new URLSearchParams({ part: 'snippet,replies', allThreadsRelatedToChannelId: own, order: 'time', maxResults: '100', ...(page && { pageToken: page }) });
      const answer = await this.#http.json<{ items?: CommentThread[]; nextPageToken?: string }>(`${API}/commentThreads?${query}`, { headers: await this.#auth(), what: 'read the channel comments' });
      let older = false;
      for (const thread of answer.items ?? []) {
        const top = thread.snippet.topLevelComment.snippet;
        const at = [top.publishedAt, top.updatedAt ?? '', ...(thread.replies?.comments ?? []).map((r) => r.snippet.publishedAt)].reduce((a, b) => (b > a ? b : a));
        newest = newest === undefined || at > newest ? at : newest;
        if (since !== undefined && at <= since) older = true;
        else if (thread.snippet.videoId) items.push({ videoId: thread.snippet.videoId, at });
      }
      page = answer.nextPageToken;
      if (older || !page || since === undefined) break;
    }
    return { items, newest };
  }

  /** A reply in the comment's thread: YouTube threads replies under the top-level comment */
  async reply(target: ReplyTarget, text: string): Promise<SentReply> {
    this.#units('commentsInsert');
    const made = await this.#http.json<{ id: string }>(`${API}/comments?part=snippet`, {
      method: 'POST',
      headers: { ...(await this.#auth()), 'content-type': 'application/json' },
      body: JSON.stringify({ snippet: { parentId: target.commentExternalId, textOriginal: text } }),
      what: 'answer the comment',
    });
    return { externalId: made.id, url: `https://www.youtube.com/watch?v=${target.postExternalId}&lc=${made.id}` };
  }
}

function toComment(id: string, s: CommentSnippet, ownChannel: string, videoId: string, inReplyTo?: string): Comment {
  const avatarUrl = imageUrl(s.authorProfileImageUrl);
  return {
    externalId: id,
    author: { handle: s.authorDisplayName ?? 'someone', ...(s.authorDisplayName && { displayName: s.authorDisplayName }), ...(avatarUrl && { avatarUrl }) },
    text: s.textOriginal ?? s.textDisplay ?? '',
    createdAt: s.publishedAt,
    ...(inReplyTo && { inReplyTo }),
    url: `https://www.youtube.com/watch?v=${videoId}&lc=${id}`,
    own: s.authorChannelId?.value === ownChannel,
  };
}

/**
 * Google's consent page for the owner's OAuth client: offline access, so the code is worth a refresh
 * token, and `prompt=consent`, since Google gives one only on a consent the account has just seen.
 * The redirect URI must be one of the client's, exactly.
 */
export function youtubeAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: YOUTUBE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
}

/** The code becomes the refresh token, which is all that is kept: each connector trades it for an hour's access */
export async function exchangeYouTubeCode(app: { clientId: string; clientSecret: string }, redirectUri: string, code: string, http: typeof fetch = globalThis.fetch): Promise<{ refreshToken: string }> {
  const client = new HttpClient({ network: 'YouTube', fetch: http });
  const response = await client.request(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: redirectUri }),
    what: 'exchange the code',
  });
  const body = (await response.json().catch(() => ({}))) as { refresh_token?: string; error?: string; error_description?: string };
  if (!response.ok) throw new ConnectorError('YouTube', `exchange the code: ${response.status} ${body.error ?? ''} ${body.error_description ?? ''}`.trim(), response.status, false);
  // No refresh token: the account had consented before without offline access; revoking Shipcast's access and connecting again gives one
  if (!body.refresh_token) throw new ConnectorError('YouTube', 'Google gave no refresh token: remove Shipcast from the Google account’s third-party access, then connect again', 400, false);
  return { refreshToken: body.refresh_token };
}
