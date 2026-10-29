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
  /** What tells this channel's pieces apart: a subreddit, an issue's language */
  content?: 'subreddit' | 'language';
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
 * A text whose network counts every character of a link (Threads, Telegram, Discord), tagged only
 * when it still fits: one the tags would push over the limit goes out as written, with its `?ref=`
 */
export function trackWithinLimit(channel: TrackedChannel, text: string, tracking: LinkTracking | undefined): string {
  const tagged = track(channel, text, tracking);
  return pieceLimitProblem(channel, tagged) ? text : tagged;
}
