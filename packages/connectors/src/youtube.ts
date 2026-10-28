import { HttpClient } from './http-client.ts';
import { checkProblem, ConnectorError, imageUrl, okCheck, PostGone, statsOf, type Check, type Comment, type CommentReader, type Deletable, type Metrics, type ProfileStats, type Published, type Replier, type ReplyTarget, type SentReply } from './http.ts';

/** The scopes Shipcast asks YouTube for: uploading, reading the channel's own data, and managing its videos, captions and comments */
export const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/youtube.force-ssl'];

/**
 * What each call costs of the project's daily quota (10,000 units by default), as Google's quota
 * calculator lists them: an upload costs as much as hundreds of reads, so the caller counts units
 * (`onUnits`) and the per-provider limiter refuses an upload the day's quota cannot pay for.
 */
export const YOUTUBE_UNITS = {
  list: 1,
  insert: 1600,
  update: 50,
  delete: 50,
  captionsInsert: 400,
  thumbnailsSet: 50,
  commentsInsert: 50,
} as const;

/** The project's daily quota when Google has not raised it */
export const YOUTUBE_DAILY_UNITS = 10_000;

export interface YouTubeOptions {
  /** The OAuth client the refresh token was issued to: a token is only good with its client */
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: typeof fetch;
  /** Told the quota units each call spends, so the day's spend can be counted and capped */
  onUnits?: (units: number, call: keyof typeof YOUTUBE_UNITS) => void;
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
  /** What Shipcast asks for; Google keeps an unaudited project's uploads private whatever is asked */
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
  parentId?: string;
}

const count = (value: string | undefined) => (value === undefined ? undefined : Number(value));

/**
 * YouTube, as the owner's channel through their OAuth client (a refresh token, offline access):
 * resumable uploads with caption tracks and a thumbnail, edits of the title, description and tags,
 * deletes, the videos' numbers read 50 at a time, the channel's own numbers, and the comments under
 * a video read and answered. Every call goes through one HttpClient (timeouts, retries of what is
 * safe to repeat, counted by the process's telemetry) and reports its quota units.
 */
export class YouTube implements Deletable, CommentReader, Replier {
  readonly #options: YouTubeOptions;
  readonly #http: HttpClient;
  #token: Promise<string> | undefined;
  #channelId: Promise<string> | undefined;

  constructor(options: YouTubeOptions) {
    this.#options = options;
    this.#http = new HttpClient({ network: 'YouTube', ...(options.fetch && { fetch: options.fetch }), timeoutMs: 60_000 });
  }

  #units(call: keyof typeof YOUTUBE_UNITS): void {
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
    this.#channelId ??= (async () => {
      this.#units('list');
      const answer = await this.#http.json<{ items?: Array<{ id: string }> }>(`${API}/channels?part=id&mine=true`, { headers: await this.#auth(), what: 'read the channel' });
      const id = answer.items?.[0]?.id;
      if (!id) throw new ConnectorError('YouTube', 'this Google account has no YouTube channel: create one, then connect again', 404, false);
      return id;
    })();
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
