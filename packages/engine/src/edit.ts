import { createHash } from 'node:crypto';
import { ConnectorError } from '@shipcast/connectors';
import type { Channel } from '@shipcast/schema';
import { isScalar, parseDocument } from 'yaml';
import { launchDir } from './drafts.ts';
import type { CommitFile } from './github.ts';
import { kindLanguage, type Post, type Registry } from './registry.ts';

/*
 * Editing and deleting what a launch published, per piece or for a whole launch at once. A piece's
 * row is never removed: deleted is a status, so the launch still counts it as published and the
 * engine never sends it again ("a launch happens once"). See docs/decisions/edit-delete.md
 */

export type EditSupport = 'yes' | 'no' | 'partial';
/** `unpublish`: the network takes the piece off the site but keeps it in the author's drafts */
export type DeleteSupport = 'yes' | 'no' | 'unpublish';
/** What a change can carry; each network takes some of them */
export type EditField = 'text' | 'title' | 'tags' | 'link' | 'image';

export interface Capability {
  edit: EditSupport;
  delete: DeleteSupport;
  /** What the network allows or refuses, in words the app shows beside the actions */
  note: string;
  /** The fields an edit can change there */
  fields: EditField[];
}

const NOT_PUBLISHED: Capability = { edit: 'no', delete: 'no', note: 'Shipcast drafts this channel; it is posted by hand, so it is edited there too', fields: [] };

/** What each channel can do with a published piece: the map the app and the API read. */
export const CAPABILITIES: Readonly<Record<Channel, Capability>> = {
  blog: {
    edit: 'yes',
    delete: 'yes',
    note: 'By a commit to the launches repo, which deploys the site: an edit rewrites the article and sets its updatedDate; a delete removes it, and its media once no other language of the launch is left',
    fields: ['text', 'title', 'tags'],
  },
  devto: {
    edit: 'yes',
    delete: 'unpublish',
    note: 'dev.to has no delete in its API: the article is unpublished and stays in the author’s dashboard',
    fields: ['text', 'title', 'tags', 'link', 'image'],
  },
  hashnode: { edit: 'yes', delete: 'yes', note: 'Through updatePost and removePost; the API answers only publications on the Pro plan', fields: ['text', 'title', 'tags', 'link', 'image'] },
  mastodon: { edit: 'yes', delete: 'yes', note: 'An edit keeps the post’s replies and boosts, and Mastodon shows it as edited', fields: ['text', 'link', 'image'] },
  telegram: {
    edit: 'yes',
    delete: 'yes',
    note: 'The text, or the caption of a photo (with its photo); Telegram refuses to delete a message older than 48 hours',
    fields: ['text', 'link', 'image'],
  },
  discord: { edit: 'yes', delete: 'yes', note: 'Through the webhook that sent the message', fields: ['text', 'link'] },
  bluesky: {
    edit: 'no',
    delete: 'yes',
    note: 'Bluesky has no edit: a post can only be deleted and posted again, which loses its likes and replies, so Shipcast never does that on its own',
    fields: [],
  },
  instagram: {
    edit: 'no',
    delete: 'no',
    note: 'Instagram’s API changes no caption of a published post and deletes no post; that is done in the app',
    fields: [],
  },
  newsletter: { edit: 'no', delete: 'no', note: 'A sent campaign is in the readers’ inboxes already', fields: [] },
  reddit: NOT_PUBLISHED,
  hackerNews: NOT_PUBLISHED,
  productHunt: NOT_PUBLISHED,
  linkedin: { ...NOT_PUBLISHED, note: 'Not connected yet' },
  x: { ...NOT_PUBLISHED, note: 'Not connected yet' },
};

/** Why an edit or a delete was not made, so the API can answer 404 or 409 */
export type RefusalReason = 'not_found' | 'unsupported' | 'deleted' | 'invalid' | 'no_credentials';

export class PostRefused extends Error {
  readonly reason: RefusalReason;

  constructor(reason: RefusalReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

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

/** What the engine needs from each network's connector to change what it published; `@shipcast/connectors` fits. */
export interface Editors {
  mastodon?: { edit(id: string, e: { text?: string; image?: Image }): Promise<void>; delete(id: string): Promise<void> };
  telegram?: { edit(id: string, e: { text: string; imageUrl?: string }): Promise<void>; delete(id: string): Promise<void> };
  discord?: { edit(id: string, e: { content: string }): Promise<void>; delete(id: string): Promise<void> };
  devto?: {
    edit(id: string, e: { title?: string; markdown?: string; tags?: string[]; canonicalUrl?: string; mainImage?: string }): Promise<void>;
    delete(id: string): Promise<void>;
  };
  hashnode?: {
    edit(id: string, e: { title?: string; markdown?: string; tags?: string[]; canonicalUrl?: string; coverImageUrl?: string }): Promise<void>;
    delete(id: string): Promise<void>;
  };
  bluesky?: { delete(id: string): Promise<void> };
}

/** The launches repo, for the blog's articles: read a file, commit onto a branch, list a folder */
export interface BlogRepo {
  fileAt(repo: string, path: string, ref: string): Promise<string | undefined>;
  commitToBranch(repo: string, branch: string, message: string, files: CommitFile[]): Promise<{ sha: string }>;
  filesUnder(repo: string, ref: string, folder: string): Promise<string[]>;
}

export interface EditDeps {
  registry: Registry;
  /**
   * The connectors of a channel built with the account a piece went out with (`null`: the `.env`
   * credentials), never the channel's primary account of today, which may be another one.
   */
  editors(channel: Channel, accountId: number | null): Promise<Editors>;
  blog?: { github: BlogRepo; launchesRepo: string };
  /** For an image Mastodon needs as bytes */
  fetch?: typeof fetch;
  now?: () => Date;
}

/** The hash of what an edit sent, so a later reader can tell which version is out */
export function contentHash(changes: PostChanges): string {
  const sorted = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

const NAMES: Partial<Record<Channel, string>> = { devto: 'dev.to', hashnode: 'Hashnode', mastodon: 'Mastodon', telegram: 'Telegram', discord: 'Discord', bluesky: 'Bluesky', instagram: 'Instagram', newsletter: 'The newsletter', blog: 'The blog' };
const nameOf = (channel: Channel) => NAMES[channel] ?? channel;

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

/** A post's own piece, or a blog article; a story, a comment or a newsletter issue is not edited from here */
function isMain(post: Post): boolean {
  return post.channel === 'blog' ? post.kind.startsWith('article:') : post.kind === 'post';
}

function describe(post: Post): string {
  return post.kind === 'post' ? `${nameOf(post.channel)} post ${post.id}` : `${nameOf(post.channel)} ${post.kind} ${post.id}`;
}

async function existing(registry: Registry, postId: number): Promise<Post> {
  const post = await registry.post(postId);
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
  if (changes.text === undefined) return undefined;
  return changes.link ? `${changes.text.trimEnd()}\n\n${changes.link}` : changes.text;
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

const splitFrontMatter = (markdown: string) => /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(markdown);
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
  const parts = current === undefined ? null : splitFrontMatter(current);
  if (!parts) throw new PostRefused('not_found', `${path} is not on the launches repo’s main branch, or has no front matter`);
  // The document API keeps the front matter as written: its quoting, order and comments
  const front = parseDocument(parts[1]!);
  const set = (key: string, value: string | string[]) => {
    const node = front.get(key, true);
    // A scalar changed in place keeps its quotes; a new one is written plain
    if (typeof value === 'string' && isScalar(node)) node.value = value;
    else front.set(key, value);
  };
  if (changes.title !== undefined) set('title', changes.title);
  if (changes.tags !== undefined) set('tags', changes.tags);
  set('updatedDate', (deps.now?.() ?? new Date()).toISOString().slice(0, 10));
  const body = changes.text ?? parts[2]!;
  const content = `---\n${front.toString().trimEnd()}\n---\n\n${body.trim()}\n`;
  await github.commitToBranch(launchesRepo, 'main', `Edit the article ${post.externalId} (${kindLanguage(post.kind)})`, [{ path, content }]);
}

/**
 * Removes the article from the launches repo's main branch, and the launch's media folder with it
 * once no other language of the launch is left: the other article still shows those images.
 */
async function deleteArticle(post: Post, deps: EditDeps): Promise<void> {
  const { github, launchesRepo } = blogOf(deps);
  const launch = await deps.registry.get(post.launchId);
  if (!launch) throw new PostRefused('not_found', 'the post’s launch is gone');
  const path = articlePath(post);
  const files: CommitFile[] = [];
  if ((await github.fileAt(launchesRepo, path, 'HEAD')) !== undefined) files.push({ path, delete: true });
  const others = (await deps.registry.posts(post.launchId, { channel: 'blog' })).filter((p) => p.id !== post.id && p.status !== 'deleted' && isMain(p));
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

/** Sends the change to the network, mapped to what its API calls each field */
async function send(post: Post, changes: PostChanges, deps: EditDeps): Promise<void> {
  if (post.channel === 'blog') return editArticle(post, changes, deps);
  const id = post.externalId!;
  const editors = await deps.editors(post.channel, post.accountId);
  switch (post.channel) {
    case 'mastodon': {
      const text = textWithLink('mastodon', changes);
      const image = changes.imageUrl ? await imageBytes(changes.imageUrl, changes.imageAlt, deps.fetch ?? globalThis.fetch) : undefined;
      return editorOf(editors, 'mastodon', post).edit(id, { ...(text !== undefined && { text }), ...(image && { image }) });
    }
    case 'telegram': {
      const text = textWithLink('telegram', changes);
      // The Bot API cannot read the caption back, so a new photo needs its caption with it
      if (text === undefined) throw new PostRefused('invalid', 'Telegram replaces the text or caption whole: send the text');
      return editorOf(editors, 'telegram', post).edit(id, { text, ...(changes.imageUrl && { imageUrl: changes.imageUrl }) });
    }
    case 'discord': {
      const content = textWithLink('discord', changes);
      if (content === undefined) throw new PostRefused('invalid', 'Discord replaces the message’s text whole: send the text');
      return editorOf(editors, 'discord', post).edit(id, { content });
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
    default:
      throw new PostRefused('unsupported', `${nameOf(post.channel)} cannot edit a published post`);
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
  return deps.registry.updatePost(post.id, { status: 'edited', contentHash: contentHash(sent) });
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
      case 'bluesky': {
        const editor = editorOf(editors, post.channel, post);
        await take(() => editor.delete(id));
        break;
      }
      default:
        throw new PostRefused('unsupported', `${nameOf(post.channel)} cannot delete a published post`);
    }
  }
  return deps.registry.updatePost(post.id, { status: 'deleted' });
}

/** One piece's result in an operation on a whole launch */
export type PostOutcome =
  | { postId: number; channel: Channel; kind: string; ok: true; post: Post }
  | { postId: number; channel: Channel; kind: string; ok: false; reason: RefusalReason | 'failed'; problem: string };

async function eachPost(launchId: number, channels: readonly Channel[] | undefined, deps: EditDeps, run: (post: Post) => Promise<Post>): Promise<PostOutcome[]> {
  if (!(await deps.registry.get(launchId))) throw new PostRefused('not_found', 'no such launch');
  const pieces = (await deps.registry.posts(launchId)).filter((p) => p.status !== 'deleted' && p.status !== 'scheduled' && (!channels || channels.includes(p.channel)));
  const outcomes: PostOutcome[] = [];
  // One at a time: a network that rate-limits sees one request of ours, and the order is the launch's
  for (const post of pieces) {
    const base = { postId: post.id, channel: post.channel, kind: post.kind };
    try {
      outcomes.push({ ...base, ok: true, post: await run(post) });
    } catch (error) {
      const reason = error instanceof PostRefused ? error.reason : 'failed';
      outcomes.push({ ...base, ok: false, reason, problem: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}

/**
 * The same change to every piece of a launch on the channels named (all of them when none are),
 * each network taking the fields it has: a text goes to Mastodon and Telegram as the post, to
 * Discord as the message, to dev.to and Hashnode as the article's body. A piece that cannot take it
 * is reported, never failing the others.
 */
export function editPosts(launchId: number, changes: PostChanges, channels: readonly Channel[] | undefined, deps: EditDeps): Promise<PostOutcome[]> {
  return eachPost(launchId, channels, deps, (post) => editPost(post.id, changes, deps, { strict: false }));
}

/** Deletes every piece of a launch on the channels named (all of them when none are), reporting what cannot be */
export function deleteLaunchPosts(launchId: number, channels: readonly Channel[] | undefined, deps: EditDeps): Promise<PostOutcome[]> {
  return eachPost(launchId, channels, deps, (post) => deletePost(post.id, deps));
}
