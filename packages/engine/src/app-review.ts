import { Marked } from 'marked';
import { parseFrontMatter, type LaunchConfig } from '@shipcast/schema';
import type { DraftFile } from './drafts.ts';
import { draftPath } from './launch-store.ts';
import type { Launch, StoredApproval, StoredDraft } from './repositories/index.ts';

/** Each draft's current version, by draft id: what the review shows and what an approval names */
export function currentVersions(drafts: readonly Pick<StoredDraft, 'id' | 'versionId'>[]): Record<string, number> {
  return Object.fromEntries(drafts.map((d) => [String(d.id), d.versionId]));
}

/** Whether the versions the owner read are every draft's current one, no more and no fewer */
export function sameVersions(seen: Readonly<Record<string, number>>, current: Readonly<Record<string, number>>): boolean {
  const keys = Object.keys(current);
  return keys.length === Object.keys(seen).length && keys.every((id) => seen[id] === current[id]);
}

/*
 * The launch model's fifth phase (docs/app-review.md): a launch held by Shipcast is reviewed,
 * previewed and approved in the app, with no pull request. What is pure of it lives here: the drafts'
 * mode lines, which channels may go out, the article's preview and the real site's preview address.
 */

/** Whether Shipcast, not a pull request, holds the launch's drafts and approval */
export const isAppLaunch = (launch: Pick<Launch, 'model'>): boolean => launch.model === 'app';

/** The cursor that keeps the commit that put a launch on the site: written once, so a retry never commits twice */
export const appBlogKey = (launchId: number) => `app-blog:${launchId}`;
/** The cursor that keeps a launch's preview on the real site: its branch, its pull request and its address */
export const appPreviewKey = (launchId: number) => `app-preview:${launchId}`;

/** The commit of the site's files (the articles, the media) a launch was published with */
export interface BlogCommit {
  sha: string;
  at: string;
}

/** A launch's preview on the real site: a branch of the launches repo whose draft pull request the site's workflow deploys */
export interface SitePreview {
  branch: string;
  number: number;
  pullRequest: string;
  /** The commit the preview was last asked for */
  sha: string;
  at: string;
  /** The preview's address once the site's workflow wrote it, and the commit it shows */
  url?: string;
  urlSha?: string;
}

const PENDING = /^> \*\*(Approval|Auto):\*\* .*$/m;

/**
 * The drafts of a launch held by Shipcast say how they go out in the app's words: their mode line
 * would otherwise speak of a pull request there is none of. Only the line changes, so publishing and
 * draftBody read them as any other.
 */
export function forAppReview(files: readonly DraftFile[]): DraftFile[] {
  return files.map((f) => {
    if (!('content' in f) || !f.path.endsWith('.md')) return f;
    const mode = PENDING.exec(f.content)?.[1];
    if (!mode) return f;
    const line = mode === 'Auto' ? '> **Auto:** published as soon as it is ready, without waiting for approval.' : '> **Approval:** published once approved in Shipcast. Edit it there if it needs changes.';
    return { ...f, content: f.content.replace(PENDING, line) };
  });
}

/**
 * Why each channel of the launch may not go out yet, by channel; a channel left out may. `auto` never
 * waits; `approval` waits until an approval is in force and names the current version of every one of
 * the channel's drafts, so an edit after approving holds back that channel alone until it is approved
 * again. Channels that are off are not listed: they never go out.
 */
export function channelWaits(input: { config: LaunchConfig; drafts: readonly StoredDraft[]; approval: StoredApproval | undefined }): Map<string, string> {
  const waits = new Map<string, string>();
  for (const [channel, mode] of Object.entries(input.config.publishing)) {
    if (mode !== 'approval') continue;
    if (!input.approval) {
      waits.set(channel, 'waits for approval');
      continue;
    }
    const versions = input.approval.versions;
    if (input.drafts.some((d) => d.channel === channel && versions[String(d.id)] !== d.versionId)) waits.set(channel, 'edited since it was approved: approve it again');
  }
  return waits;
}

/** Whether each draft's current version is the one the approval in force names, by the draft's path */
export function approvedDrafts(drafts: readonly StoredDraft[], approval: StoredApproval | undefined): Map<string, boolean> {
  return new Map(drafts.flatMap((d) => {
    const path = draftPath(d);
    return path ? [[path, approval?.versions[String(d.id)] === d.versionId] as const] : [];
  }));
}

/** An article as the in-app preview shows it */
export interface ArticlePreview {
  title: string;
  description: string;
  /** The launch image (front matter `image`), at the address the app serves it from */
  image?: string;
  imageAlt?: string;
  /** The body as HTML: any HTML written in the Markdown is shown as text, and only web, mail and in-page links are kept */
  html: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const SAFE_URL = /^(https?:\/\/|mailto:|#)/i;

/**
 * The article as the blog renders it, as close as the app can without the site: its front matter's
 * title, description and image over the Markdown rendered as GitHub-flavoured HTML, as Astro does.
 * The text is the AI's or the owner's, so nothing in it runs: raw HTML is escaped and a link that is
 * not http(s), mail or an anchor goes nowhere. A root-relative path is the site's: an image the launch
 * holds is shown from the app (`media`), anything else points at the site.
 */
export function articlePreview(file: string, options: { site: string; media: (publicPath: string) => string | undefined }): ArticlePreview {
  const { data, body } = parseFrontMatter(file);
  const origin = new URL(options.site).origin;
  const href = (url: string, image: boolean): string => {
    const trimmed = url.trim();
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return (image ? options.media(trimmed) : undefined) ?? `${origin}${trimmed}`;
    return SAFE_URL.test(trimmed) ? trimmed : '#';
  };
  const marked = new Marked({
    gfm: true,
    walkTokens: (token) => {
      if (token.type === 'link' || token.type === 'image') token.href = href(token.href, token.type === 'image');
    },
    renderer: {
      html: (token) => esc(token.text),
    },
  });
  const string = (key: string) => (typeof data[key] === 'string' ? (data[key] as string) : undefined);
  const image = string('image');
  return {
    title: string('title') ?? '',
    description: string('description') ?? '',
    ...(image && { image: href(image, true) }),
    ...(string('imageAlt') && { imageAlt: string('imageAlt') }),
    html: marked.parse(body, { async: false }) as string,
  };
}

const PREVIEW_MARK = '<!-- cloudflare-preview -->';

/**
 * The preview's address from the comments of its pull request: the launches repo's workflow writes
 * one marked comment per upload, with the commit it built and the branch's stable address (or the
 * version's). The newest such comment wins; none yet while the workflow runs.
 */
export function previewAddress(comments: readonly string[]): { url: string; sha: string | undefined } | undefined {
  const comment = [...comments].reverse().find((c) => c.includes(PREVIEW_MARK));
  if (!comment) return undefined;
  const branch = /Branch:\s*(https:\/\/[a-z0-9-]+\.[a-z0-9.-]+\.workers\.dev\S*)/i.exec(comment)?.[1];
  const version = /This version:\s*(https:\/\/[a-z0-9-]+\.[a-z0-9.-]+\.workers\.dev\S*)/i.exec(comment)?.[1];
  const url = branch ?? version;
  if (!url) return undefined;
  return { url, sha: /`([0-9a-f]{7,40})`/.exec(comment)?.[1] };
}
