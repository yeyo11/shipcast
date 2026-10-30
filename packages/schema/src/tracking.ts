import type { Channel } from './channels.ts';
import { pieceLimitProblem } from './content-pack.ts';

/*
 * UTM tags on the links Shipcast publishes (docs/tracking.md): every link to the brand's site names
 * the network and the launch the visit came from, so the site's analytics credit each one to a
 * channel and a campaign instead of a bare referral. The one place the tags are decided; each
 * channel's adapter (packages/runtime/src/channels) only calls `track` or `trackUrl` where its text,
 * card or embed goes out. Always on: the campaign is the launch's own until a launch can say
 * otherwise. Claude still writes `?ref=<channel>` (short, and the fallback where the tags do not fit).
 */

/** What one channel's links say about where a visit came from; `content` is filled per piece */
export interface UtmChannel {
  source: string;
  medium: 'social' | 'email';
  /** What tells this channel's pieces apart: a subreddit, an issue's language, a video's format (`short`, `video`) */
  content?: 'subreddit' | 'language' | 'format';
}

/**
 * The channels whose links are tagged. dev.to and Hashnode are not: their canonical URL must stay
 * clean, and the referrer names them already. Instagram has no clickable links. With `social` as the
 * medium, GA4 files a visit under Organic Social whatever its source.
 */
export const UTM_CHANNELS = {
  bluesky: { source: 'bluesky', medium: 'social' },
  mastodon: { source: 'mastodon', medium: 'social' },
  threads: { source: 'threads', medium: 'social' },
  linkedin: { source: 'linkedin', medium: 'social' },
  telegram: { source: 'telegram', medium: 'social' },
  discord: { source: 'discord', medium: 'social' },
  reddit: { source: 'reddit', medium: 'social', content: 'subreddit' },
  githubDiscussions: { source: 'github', medium: 'social' },
  newsletter: { source: 'newsletter', medium: 'email', content: 'language' },
  youtube: { source: 'youtube', medium: 'social', content: 'format' },
} as const satisfies Partial<Record<Channel, UtmChannel>>;

export type TrackedChannel = keyof typeof UTM_CHANNELS;

/** The tags one link gets */
export interface Utm {
  source: string;
  medium: string;
  campaign: string;
  content?: string;
}

/** What the engine hands a channel's publisher with a piece: the site whose links are tagged, and the launch's campaign */
export interface LinkTracking {
  site: string;
  campaign: string;
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * A launch's campaign: `<project>-<version>` for a release (`shipcast-v0-2-0`), `<project>-launch`
 * for a repo that went public, the article's slug for an article written in the app
 */
export function campaignOf(launch: { repo: string; ref: string }): string {
  if (launch.ref.startsWith('article:')) return slug(launch.ref.slice('article:'.length));
  const project = slug(launch.repo.split('/').at(-1) ?? launch.repo);
  return launch.ref.startsWith('public:') ? `${project}-launch` : slug(`${project}-${launch.ref}`);
}

/** A channel's tags for a launch's campaign; `content` where the channel tells its pieces apart */
export function utmFor(channel: TrackedChannel, campaign: string, content?: string): Utm {
  const tags: UtmChannel = UTM_CHANNELS[channel];
  const utm: Utm = { source: tags.source, medium: tags.medium, campaign };
  if (content && tags.content) utm.content = content;
  return utm;
}

const host = (url: URL) => url.hostname.replace(/^www\./, '');

/**
 * The link with the tags, when it points at the site: `ref` goes, the `utm_*` come. A link to
 * anywhere else, or one whose `utm_*` the owner wrote by hand, is left exactly as it is.
 */
export function trackedUrl(url: string, site: string, utm: Utm): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (host(parsed) !== host(new URL(site))) return url;
  } catch {
    return url;
  }
  if ([...parsed.searchParams.keys()].some((key) => key.startsWith('utm_'))) return url;
  parsed.searchParams.delete('ref');
  for (const key of ['source', 'medium', 'campaign', 'content'] as const) {
    const value = utm[key];
    if (value) parsed.searchParams.set(`utm_${key}`, value);
  }
  return parsed.toString();
}

/** A URL in plain text or Markdown: it ends at a space, a quote, a bracket or a parenthesis (`[a](url)`) */
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`()[\]]+/g;
/** Punctuation that closes a sentence after a link is not part of it */
const TRAILING = /[.,;:!?*]+$/;

/** Every link to the site in a text or Markdown body, tagged; the rest of the text as written */
export function tagLinks(text: string, site: string, utm: Utm): string {
  return text.replace(URL_IN_TEXT, (match) => {
    const url = match.replace(TRAILING, '');
    return trackedUrl(url, site, utm) + match.slice(url.length);
  });
}

/** Every `href` to the site in an HTML document (the newsletter's issue), tagged; its `&` stay escaped */
export function tagHtmlLinks(html: string, site: string, utm: Utm): string {
  return html.replace(/href="(https?:\/\/[^"]+)"/g, (_match, href: string) => {
    const url = href.replaceAll('&amp;', '&');
    return `href="${trackedUrl(url, site, utm).replaceAll('&', '&amp;')}"`;
  });
}

/** A channel's text with its links tagged; as written when the publishing gave no tracking */
export function track(channel: TrackedChannel, text: string, tracking: LinkTracking | undefined, content?: string): string {
  return tracking ? tagLinks(text, tracking.site, utmFor(channel, tracking.campaign, content)) : text;
}

/** A channel's link card or embed URL, tagged; as given when the publishing gave no tracking */
export function trackUrl(channel: TrackedChannel, url: string, tracking: LinkTracking | undefined, content?: string): string {
  return tracking ? trackedUrl(url, tracking.site, utmFor(channel, tracking.campaign, content)) : url;
}

/**
 * A text whose network counts every character of a link (Threads, Telegram, Discord, YouTube's
 * description), tagged only when it still fits: one the tags would push over the limit goes out as
 * written, with its `?ref=`. The limit is the channel's piece limit, or `max` characters for a text
 * that is not the channel's piece (a video's description).
 */
export function trackWithinLimit(channel: TrackedChannel, text: string, tracking: LinkTracking | undefined, options: { content?: string; max?: number } = {}): string {
  const tagged = track(channel, text, tracking, options.content);
  const over = options.max === undefined ? pieceLimitProblem(channel, tagged) !== undefined : tagged.length > options.max;
  return over ? text : tagged;
}

/**
 * Where a visit came from by its referrer's host, the other half of attribution: the analytics that
 * keep no query string (Cloudflare Web Analytics, dev.to's referrers) cannot read the UTM tags, so the
 * referrer is all they have. Named as the channels are (and as their `utm_source`, where they are
 * tagged); `x`, `hackernews` and `facebook` are not channels but send readers all the same. A host
 * matches itself and its subdomains. Mastodon readers arrive from their own instance, which can be
 * any host: only mastodon.social is told apart, every other counts as `other`.
 */
export const REFERRER_HOSTS = {
  bluesky: ['bsky.app'],
  devto: ['dev.to'],
  instagram: ['instagram.com'],
  reddit: ['reddit.com', 'redd.it'],
  mastodon: ['mastodon.social'],
  linkedin: ['linkedin.com', 'lnkd.in'],
  threads: ['threads.net', 'threads.com'],
  youtube: ['youtube.com', 'youtu.be'],
  hashnode: ['hashnode.com', 'hashnode.dev'],
  telegram: ['t.me', 'telegram.org', 'telegram.me'],
  discord: ['discord.com', 'discordapp.com', 'discord.gg'],
  github: ['github.com'],
  x: ['x.com', 'twitter.com', 't.co'],
  hackernews: ['news.ycombinator.com'],
  facebook: ['facebook.com', 'fb.com', 'fb.me'],
} as const satisfies Record<string, readonly string[]>;

/** The search engines a visit can come from, whatever their country's domain */
const SEARCH = /(^|\.)(google|bing|duckduckgo|ecosia|yahoo|yandex|baidu)\./;

/**
 * The source of a visit, by its referrer's host and, where it tells more, its path: `direct` without
 * a referrer, a channel (`githubDiscussions` for a discussion's page on GitHub), `search`, or `other`.
 */
export function sourceOfReferrer(host: string | null | undefined, path?: string | null): string {
  const h = (host ?? '').trim().toLowerCase().replace(/^www\./, '');
  if (!h) return 'direct';
  if (SEARCH.test(h)) return 'search';
  for (const [source, hosts] of Object.entries(REFERRER_HOSTS) as Array<[string, readonly string[]]>) {
    if (!hosts.some((known) => h === known || h.endsWith(`.${known}`))) continue;
    // A link in a discussion of the launched repo, not the repo's own page
    if (source === 'github' && /^\/[^/]+\/[^/]+\/discussions(\/|$)/.test(path ?? '')) return 'githubDiscussions';
    return source;
  }
  return 'other';
}
