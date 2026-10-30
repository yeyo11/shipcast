import { createHash } from 'node:crypto';
import { ConnectorError } from '@shipcast/connectors';
import { CAPABILITIES, campaignOf, channelAtStart, isMainPiece, Refused, splitFrontMatter, type Channel, type EditField, type LinkTracking } from '@shipcast/schema';
import { isScalar, parseDocument } from 'yaml';
import { launchDir } from './drafts.ts';
import type { CommitFile } from './github.ts';
import { composedText } from './edit-rules.ts';
import type { PostStore } from './ports.ts';
import { kindLanguage, type Post } from './repositories/posts.ts';
import type { LaunchStoreService } from './services/launch-store.ts';

/*
 * Editing and deleting what a launch published, per piece or for a whole launch at once. A piece's
 * row is never removed: deleted is a status, so the launch still counts it as published and the
 * engine never sends it again ("a launch happens once"). See docs/decisions/edit-delete.md
 */

export type { Capability, DeleteSupport, EditField, EditSupport } from '@shipcast/schema';

/** What each channel can do with a published piece: the map the app and the API read, from the channel definitions. */
export { CAPABILITIES };

/** Why an edit or a delete was not made, so the API can answer 404 or 409 */
export type RefusalReason = 'not_found' | 'unsupported' | 'deleted' | 'invalid' | 'no_credentials';

export class PostRefused extends Refused<RefusalReason> {}

/**
 * A change to published pieces. The shared fields (text, link, image) are what every network has in
 * some form and what an edit of several channels at once sends; title and tags are the articles'.
 */
export interface PostChanges {
  /** The post's text; on dev.to, Hashnode and the blog, the article's Markdown body */
  text?: string;
  title?: string;
  tags?: string[];
  /** Added at the end of the text on the networks whose posts are text; the canonical URL on dev.to and Hashnode */
  link?: string;
  /** An absolute URL; Mastodon gets the bytes, the others the address */
  imageUrl?: string;
  /** What the image shows, for screen readers where the network keeps it */
  imageAlt?: string;
}

type Image = { bytes: Uint8Array; mimeType: string; filename: string; description: string };

/**
 * What an edit's links are tagged with, as publishing tags them (docs/tracking.md): the launch's
 * tracking and the piece's kind, which names its `utm_content` where a channel tells its pieces apart
 * (YouTube's `post:short` and `post:video`)
 */
export type EditTracking = LinkTracking & { kind: string };

/**
 * What the engine needs from each network's connector to change what it published; `@shipcast/connectors`
 * fits. A channel whose links are tagged is handed the edit's `tracking`: its adapter tags the links as
 * it does when publishing, the connector never sees it.
 */
export interface Editors {
  mastodon?: { edit(id: string, e: { text?: string; image?: Image }, tracking?: EditTracking): Promise<void>; delete(id: string): Promise<void> };
  telegram?: { edit(id: string, e: { text: string; imageUrl?: string }, tracking?: EditTracking): Promise<void>; delete(id: string): Promise<void> };
  discord?: { edit(id: string, e: { content: string }, tracking?: EditTracking): Promise<void>; delete(id: string): Promise<void> };
  devto?: {
    edit(id: string, e: { title?: string; markdown?: string; tags?: string[]; canonicalUrl?: string; mainImage?: string }): Promise<void>;
    delete(id: string): Promise<void>;
  };
  hashnode?: {
    edit(id: string, e: { title?: string; markdown?: string; tags?: string[]; canonicalUrl?: string; coverImageUrl?: string }): Promise<void>;
    delete(id: string): Promise<void>;
  };
  bluesky?: { delete(id: string): Promise<void> };
  githubDiscussions?: { edit(id: string, e: { title?: string; body?: string }, tracking?: EditTracking): Promise<void>; delete(id: string): Promise<void> };
  threads?: { delete(id: string): Promise<void> };
  linkedin?: { delete(id: string): Promise<void> };
  reddit?: { delete(id: string): Promise<void> };
}

/**
 * The editor of a channel the engine has no field mapping built in for (`send` below): it takes the
 * change as the engine has it, and its adapter maps the fields to what its API calls them. A new
 * network edits through this instead of a branch here.
 */
export interface ChangeEditor {
  edit?(id: string, changes: PostChanges, tracking?: EditTracking): Promise<void>;
  delete?(id: string): Promise<void>;
}

/** A channel's editor under its id when it is not one of Editors' typed ones */
function changeEditorOf(editors: Editors, channel: string): ChangeEditor | undefined {
  const found: unknown = (editors as object as Record<string, unknown>)[channel];
  return found && typeof found === 'object' ? (found as ChangeEditor) : undefined;
}

/** The launches repo, for the blog's articles: read a file, commit onto a branch, list a folder */
export interface BlogRepo {
  fileAt(repo: string, path: string, ref: string): Promise<string | undefined>;
  commitToBranch(repo: string, branch: string, message: string, files: CommitFile[]): Promise<{ sha: string }>;
  filesUnder(repo: string, ref: string, folder: string): Promise<string[]>;
}

export interface EditDeps {
  registry: PostStore;
  /**
   * The connectors of a channel built with the account a piece went out with (`null`: the `.env`
   * credentials), never the channel's primary account of today, which may be another one.
   */
  editors(channel: Channel, accountId: number | null): Promise<Editors>;
  blog?: { github: BlogRepo; launchesRepo: string };
  /**
   * With `launch-store`: an article edited after publishing is also a version in the launch model,
   * so what the launch page reads from it (`launch-store-read`) is the article as the site shows it
   */
  launchStore?: Pick<LaunchStoreService, 'articleEdited'> | undefined;
  /** For an image Mastodon needs as bytes */
  fetch?: typeof fetch;
  now?: () => Date;
  /** The brand's site, whose links an edit tags as publishing does; without it an edit goes out as written */
  site?: string;
}

/** The hash of what an edit sent, so a later reader can tell which version is out */
export function contentHash(changes: PostChanges): string {
  const sorted = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

// A piece is described opening a sentence: "The newsletter post 4"
const nameOf = (channel: Channel) => channelAtStart(channel);

/** The fields a change carries */
function fieldsOf(changes: PostChanges): EditField[] {
  const fields: EditField[] = [];
  if (changes.text !== undefined) fields.push('text');
  if (changes.title !== undefined) fields.push('title');
  if (changes.tags !== undefined) fields.push('tags');
  if (changes.link !== undefined) fields.push('link');
  if (changes.imageUrl !== undefined) fields.push('image');
  return fields;
}

/** A post's own piece, a blog article or a subreddit's post (edit-rules.ts, which the page reads too) */
const isMain = (post: Post) => isMainPiece(post.channel, post.kind);

function describe(post: Post): string {
  return post.kind === 'post' ? `${nameOf(post.channel)} post ${post.id}` : `${nameOf(post.channel)} ${post.kind} ${post.id}`;
}

async function existing(registry: PostStore, postId: number): Promise<Post> {
  const post = await registry.posts.post(postId);
  if (!post) throw new PostRefused('not_found', 'no such post');
  return post;
}

/** Refuses what the network cannot do, before any request leaves */
function assertCan(post: Post, action: 'edit' | 'delete'): void {
  if (post.status === 'deleted') throw new PostRefused('deleted', `${describe(post)} was deleted already`);
  // Nothing of it is on the network yet: its schedule is what changes (PATCH or DELETE /posts/{id}/schedule)
  if (post.status === 'scheduled') throw new PostRefused('unsupported', `${describe(post)} is scheduled and not out yet: move or cancel its schedule instead`);
  const capability = CAPABILITIES[post.channel];
  if (capability[action] === 'no') throw new PostRefused('unsupported', `${nameOf(post.channel)} cannot ${action} a published post: ${capability.note}`);
  if (!isMain(post)) throw new PostRefused('unsupported', `${describe(post)} cannot be ${action === 'edit' ? 'edited' : 'deleted'} from Shipcast, only the post it belongs to`);
  if (!post.externalId) throw new PostRefused('unsupported', `${describe(post)} has no id on ${nameOf(post.channel)} to ${action} it by`);
}

/** The text with the link after it, for the networks whose post is text alone */
function textWithLink(channel: Channel, changes: PostChanges): string | undefined {
  if (changes.link !== undefined && changes.text === undefined) {
    throw new PostRefused('invalid', `${nameOf(channel)} replaces the whole text: send the text with the link`);
  }
  return composedText(channel, changes);
}

async function imageBytes(url: string, alt: string | undefined, http: typeof fetch): Promise<Image> {
  const response = await http(url);
  if (!response.ok) throw new PostRefused('invalid', `${url} answered ${response.status}`);
  const filename = new URL(url).pathname.split('/').at(-1) || 'image';
  return { bytes: new Uint8Array(await response.arrayBuffer()), mimeType: response.headers.get('content-type') ?? 'image/jpeg', filename, description: alt ?? '' };
}

function editorOf<K extends keyof Editors>(editors: Editors, channel: K, post: Post): NonNullable<Editors[K]> {
  const editor = editors[channel];
  if (!editor) {
    const who = post.accountId === null ? 'the credentials in .env' : `account ${post.accountId}`;
    throw new PostRefused('no_credentials', `${nameOf(channel)}: no credentials for ${who}, which ${describe(post)} went out with`);
  }
  return editor as NonNullable<Editors[K]>;
}

const articlePath = (post: Post) => `src/content/posts/${kindLanguage(post.kind)}/${post.externalId}.md`;

function blogOf(deps: EditDeps): NonNullable<EditDeps['blog']> {
  if (!deps.blog) throw new PostRefused('no_credentials', 'the blog is edited through GitHub, and no GitHub client was given');
  return deps.blog;
}

/** Rewrites the article on the launches repo's main branch: its body, title and tags, and its updatedDate */
async function editArticle(post: Post, changes: PostChanges, deps: EditDeps): Promise<void> {
  const { github, launchesRepo } = blogOf(deps);
  const path = articlePath(post);
  const current = await github.fileAt(launchesRepo, path, 'HEAD');
  const parts = current === undefined ? undefined : splitFrontMatter(current);
  if (!parts) throw new PostRefused('not_found', `${path} is not on the launches repo’s main branch, or has no front matter`);
  // The document API keeps the front matter as written: its quoting, order and comments
  const front = parseDocument(parts.front);
  const set = (key: string, value: string | string[]) => {
    const node = front.get(key, true);
    // A scalar changed in place keeps its quotes; a new one is written plain
    if (typeof value === 'string' && isScalar(node)) node.value = value;
    else front.set(key, value);
  };
  if (changes.title !== undefined) set('title', changes.title);
  if (changes.tags !== undefined) set('tags', changes.tags);
  set('updatedDate', (deps.now?.() ?? new Date()).toISOString().slice(0, 10));
  const body = changes.text ?? parts.body;
  const content = `---\n${front.toString().trimEnd()}\n---\n\n${body.trim()}\n`;
  await github.commitToBranch(launchesRepo, 'main', `Edit the article ${post.externalId} (${kindLanguage(post.kind)})`, [{ path, content }]);
  // It reports what it could not store on its own and never throws: the edit is made either way
  if (deps.launchStore) {
    const launch = await deps.registry.launches.get(post.launchId).catch(() => undefined);
    if (launch) await deps.launchStore.articleEdited(launch, post.id, path, content);
  }
}

/**
 * Removes the article from the launches repo's main branch, and the launch's media folder with it
 * once no other language of the launch is left: the other article still shows those images.
 */
async function deleteArticle(post: Post, deps: EditDeps): Promise<void> {
  const { github, launchesRepo } = blogOf(deps);
  const launch = await deps.registry.launches.get(post.launchId);
  if (!launch) throw new PostRefused('not_found', 'the post’s launch is gone');
  const path = articlePath(post);
  const files: CommitFile[] = [];
  if ((await github.fileAt(launchesRepo, path, 'HEAD')) !== undefined) files.push({ path, delete: true });
  const others = (await deps.registry.posts.posts(post.launchId, { channel: 'blog' })).filter((p) => p.id !== post.id && p.status !== 'deleted' && isMain(p));
  if (others.length === 0) for (const media of await github.filesUnder(launchesRepo, 'HEAD', `public/${launchDir(launch)}`)) files.push({ path: media, delete: true });
  // Nothing left to remove: the article went another way, and the row only has to say so
  if (files.length > 0) await github.commitToBranch(launchesRepo, 'main', `Delete the article ${post.externalId} (${kindLanguage(post.kind)})`, files);
}

/**
 * The fields of `changes` the post's network takes; `strict` refuses one it does not, as an edit of
 * one post does, while an edit of several channels applies what fits each.
 */
function applicable(post: Post, changes: PostChanges, strict: boolean): PostChanges {
  const allowed = CAPABILITIES[post.channel].fields;
  const refused = fieldsOf(changes).filter((f) => !allowed.includes(f));
  if (strict && refused.length > 0) throw new PostRefused('invalid', `${nameOf(post.channel)} cannot change ${refused.join(', ')}; it takes ${allowed.join(', ')}`);
  const kept: PostChanges = {
    ...(allowed.includes('text') && changes.text !== undefined && { text: changes.text }),
    ...(allowed.includes('title') && changes.title !== undefined && { title: changes.title }),
    ...(allowed.includes('tags') && changes.tags !== undefined && { tags: changes.tags }),
    ...(allowed.includes('link') && changes.link !== undefined && { link: changes.link }),
    ...(allowed.includes('image') && changes.imageUrl !== undefined && { imageUrl: changes.imageUrl, imageAlt: changes.imageAlt }),
  };
  if (fieldsOf(kept).length === 0) throw new PostRefused('invalid', `nothing in this change applies to ${nameOf(post.channel)}, which takes ${allowed.join(', ')}`);
  return kept;
}

/** The tags an edit of the piece carries: its launch's campaign on the brand's site, and its kind */
async function trackingOf(post: Post, deps: EditDeps): Promise<EditTracking | undefined> {
  if (!deps.site) return undefined;
  const launch = await deps.registry.launches.get(post.launchId).catch(() => undefined);
  return launch ? { site: deps.site, campaign: campaignOf(launch), kind: post.kind } : undefined;
}

/** Sends the change to the network, mapped to what its API calls each field */
async function send(post: Post, changes: PostChanges, deps: EditDeps): Promise<void> {
  if (post.channel === 'blog') return editArticle(post, changes, deps);
  const id = post.externalId!;
  const editors = await deps.editors(post.channel, post.accountId);
  const tracking = await trackingOf(post, deps);
  switch (post.channel) {
    case 'mastodon': {
      const text = textWithLink('mastodon', changes);
      const image = changes.imageUrl ? await imageBytes(changes.imageUrl, changes.imageAlt, deps.fetch ?? globalThis.fetch) : undefined;
      return editorOf(editors, 'mastodon', post).edit(id, { ...(text !== undefined && { text }), ...(image && { image }) }, tracking);
    }
    case 'telegram': {
      const text = textWithLink('telegram', changes);
      // The Bot API cannot read the caption back, so a new photo needs its caption with it
      if (text === undefined) throw new PostRefused('invalid', 'Telegram replaces the text or caption whole: send the text');
      return editorOf(editors, 'telegram', post).edit(id, { text, ...(changes.imageUrl && { imageUrl: changes.imageUrl }) }, tracking);
    }
    case 'discord': {
      const content = textWithLink('discord', changes);
      if (content === undefined) throw new PostRefused('invalid', 'Discord replaces the message’s text whole: send the text');
      return editorOf(editors, 'discord', post).edit(id, { content }, tracking);
    }
    case 'devto':
      return editorOf(editors, 'devto', post).edit(id, {
        ...(changes.title !== undefined && { title: changes.title }),
        ...(changes.text !== undefined && { markdown: changes.text }),
        ...(changes.tags !== undefined && { tags: changes.tags }),
        ...(changes.link !== undefined && { canonicalUrl: changes.link }),
        ...(changes.imageUrl !== undefined && { mainImage: changes.imageUrl }),
      });
    case 'hashnode':
      return editorOf(editors, 'hashnode', post).edit(id, {
        ...(changes.title !== undefined && { title: changes.title }),
        ...(changes.text !== undefined && { markdown: changes.text }),
        ...(changes.tags !== undefined && { tags: changes.tags }),
        ...(changes.link !== undefined && { canonicalUrl: changes.link }),
        ...(changes.imageUrl !== undefined && { coverImageUrl: changes.imageUrl }),
      });
    case 'githubDiscussions':
      return editorOf(editors, 'githubDiscussions', post).edit(id, {
        ...(changes.title !== undefined && { title: changes.title }),
        ...(changes.text !== undefined && { body: changes.text }),
      }, tracking);
    default: {
      const editor = changeEditorOf(editors, post.channel);
      if (editor?.edit) return editor.edit(id, changes, tracking);
      // A channel that edits but whose editor is missing went out with credentials that are gone
      if (CAPABILITIES[post.channel].edit !== 'no') editorOf(editors, post.channel as keyof Editors, post);
      throw new PostRefused('unsupported', `${nameOf(post.channel)} cannot edit a published post`);
    }
  }
}

/**
 * Edits one published piece with the account it went out with, and records it as edited with the
 * hash of what was sent. What the network cannot change is refused before anything is sent.
 */
export async function editPost(postId: number, changes: PostChanges, deps: EditDeps, options: { strict?: boolean } = {}): Promise<Post> {
  const post = await existing(deps.registry, postId);
  assertCan(post, 'edit');
  const sent = applicable(post, changes, options.strict ?? true);
  await send(post, sent, deps);
  return deps.registry.posts.updatePost(post.id, { status: 'edited', contentHash: contentHash(sent) });
}

/**
 * Deletes one published piece (dev.to unpublishes it) and records it as deleted. The row stays, so
 * the launch never publishes that piece again. A network that answers it is gone already is taken
 * at its word: the piece was ours, and gone is what was asked.
 */
export async function deletePost(postId: number, deps: EditDeps): Promise<Post> {
  const post = await existing(deps.registry, postId);
  assertCan(post, 'delete');
  if (post.channel === 'blog') {
    await deleteArticle(post, deps);
  } else {
    const editors = await deps.editors(post.channel, post.accountId);
    const id = post.externalId!;
    const take = async (run: () => Promise<void>) => {
      try {
        await run();
      } catch (error) {
        if (!(error instanceof ConnectorError && error.status === 404)) throw error;
      }
    };
    switch (post.channel) {
      case 'mastodon':
      case 'telegram':
      case 'discord':
      case 'devto':
      case 'hashnode':
      case 'bluesky':
      case 'githubDiscussions':
      case 'threads':
      case 'linkedin':
      case 'reddit': {
        const editor = editorOf(editors, post.channel, post);
        await take(() => editor.delete(id));
        break;
      }
      default: {
        const editor = changeEditorOf(editors, post.channel);
        if (editor?.delete) {
          const remove = editor.delete.bind(editor);
          await take(() => remove(id));
          break;
        }
        if (CAPABILITIES[post.channel].delete !== 'no') editorOf(editors, post.channel as keyof Editors, post);
        throw new PostRefused('unsupported', `${nameOf(post.channel)} cannot delete a published post`);
      }
    }
  }
  return deps.registry.posts.updatePost(post.id, { status: 'deleted' });
}

/**
 * One piece's result in an operation on several. A piece named by an id that is not the launch's has
 * no channel to report (`''`).
 */
export type PostOutcome =
  | { postId: number; channel: Channel; kind: string; ok: true; post: Post }
  | { postId: number; channel: Channel | ''; kind: string; ok: false; reason: RefusalReason | 'failed'; problem: string };

/**
 * Which pieces of a launch an operation covers. Channels (all of them when none are named) cover
 * the pieces out on them: one deleted or still scheduled is not there to change, and is left out.
 * Ids cover exactly the pieces named, in that order, and each one that cannot be changed is
 * reported with why, deleted and scheduled ones included: the owner chose it, so silence would read
 * as done. The launch page names pieces (the blog's English article, not its Spanish one); the REST
 * API names channels.
 */
export type PostSelection = readonly Channel[] | undefined | { postIds: readonly number[] };

const outcomeOf = async (post: Pick<Post, 'id' | 'channel' | 'kind'>, run: () => Promise<Post>): Promise<PostOutcome> => {
  const base = { postId: post.id, channel: post.channel, kind: post.kind };
  try {
    return { ...base, ok: true, post: await run() };
  } catch (error) {
    const reason = error instanceof PostRefused ? error.reason : 'failed';
    return { ...base, ok: false, reason, problem: error instanceof Error ? error.message : String(error) };
  }
};

async function eachPost(launchId: number, selection: PostSelection, deps: EditDeps, run: (post: Post) => Promise<Post>): Promise<PostOutcome[]> {
  if (!(await deps.registry.launches.get(launchId))) throw new PostRefused('not_found', 'no such launch');
  const outcomes: PostOutcome[] = [];
  // One at a time: a network that rate-limits sees one request of ours, and the order is the launch's (or the owner's)
  if (selection && 'postIds' in selection) {
    for (const postId of selection.postIds) {
      const post = await deps.registry.posts.post(postId);
      if (!post || post.launchId !== launchId) {
        outcomes.push({ postId, channel: post?.channel ?? '', kind: post?.kind ?? '', ok: false, reason: 'not_found', problem: `post ${postId} is not a piece of this launch` });
        continue;
      }
      outcomes.push(await outcomeOf(post, () => run(post)));
    }
    return outcomes;
  }
  const channels = selection;
  const pieces = (await deps.registry.posts.posts(launchId)).filter((p) => p.status !== 'deleted' && p.status !== 'scheduled' && (!channels || channels.includes(p.channel)));
  for (const post of pieces) outcomes.push(await outcomeOf(post, () => run(post)));
  return outcomes;
}

/**
 * The same change to the pieces of a launch selected (PostSelection), each network taking the
 * fields it has: a text goes to Mastodon and Telegram as the post, to Discord as the message, to
 * dev.to and Hashnode as the article's body. A piece that cannot take it is reported, never failing
 * the others. This is the one multi-edit: the launch page and the REST API both call it.
 */
export function editPosts(launchId: number, changes: PostChanges, selection: PostSelection, deps: EditDeps): Promise<PostOutcome[]> {
  return eachPost(launchId, selection, deps, (post) => editPost(post.id, changes, deps, { strict: false }));
}

/** Deletes the pieces of a launch selected (every live one when no channel is named), reporting what cannot be */
export function deleteLaunchPosts(launchId: number, selection: PostSelection, deps: EditDeps): Promise<PostOutcome[]> {
  return eachPost(launchId, selection, deps, (post) => deletePost(post.id, deps));
}
