import type { Bluesky, Comment, Mastodon, YouTube } from '@shipcast/connectors';
import type { CommentFeed, FeedPost } from '@shipcast/engine';

/*
 * The comment feeds of the channels whose network has one (docs/plans/performance-refactor.md,
 * "4. Networks"): one call per account per run says which posts have new comments, and only those
 * are read. Every feed touches every post when it has no cursor yet, so the first run reads them all
 * and sets one.
 */

const all = (posts: readonly FeedPost[]) => new Set(posts.map((p) => p.externalId));

/**
 * Mastodon's mentions since the newest one seen: a reply mentions the account it answers, so a
 * comment under one of the owner's statuses, or a reply to one of those comments, is a mention. It is
 * placed by what it answers: one of the posts, a comment already recorded, or a mention earlier in
 * the same page.
 */
export function mastodonFeed(connector: Mastodon): CommentFeed {
  return {
    async changes(posts, cursor, known) {
      const { items, newest } = await connector.mentionsSince(cursor);
      if (cursor === undefined) return { cursor: newest, touched: all(posts) };
      const ids = all(posts);
      const placed = new Map<string, string>();
      const touched = new Set<string>();
      for (const item of items) {
        // A private or direct mention is not a public comment, as the per-post read has it
        if (item.inReplyTo === null || (item.visibility !== 'public' && item.visibility !== 'unlisted')) continue;
        const post = ids.has(item.inReplyTo) ? item.inReplyTo : (placed.get(item.inReplyTo) ?? (await known.postOfComment(item.inReplyTo)));
        if (post === undefined) continue;
        placed.set(item.id, post);
        touched.add(post);
      }
      return { cursor: newest, touched };
    },
  };
}

/** Bluesky's reply, mention and quote notifications since the newest one seen, each with its thread's root */
export function blueskyFeed(connector: Bluesky): CommentFeed {
  return {
    async changes(posts, cursor) {
      const { items, newest } = await connector.notificationsSince(cursor);
      if (cursor === undefined) return { cursor: newest, touched: all(posts) };
      const ids = all(posts);
      const touched = new Set(items.flatMap((n) => [n.root, n.parent].filter((uri): uri is string => uri !== undefined && ids.has(uri))));
      return { cursor: newest, touched };
    },
  };
}

/** YouTube's comment threads of the whole channel since the newest activity seen, each with its video */
export function youtubeFeed(connector: YouTube): CommentFeed {
  return {
    async changes(posts, cursor) {
      const { items, newest } = await connector.threadsSince(cursor);
      if (cursor === undefined) return { cursor: newest, touched: all(posts) };
      const ids = all(posts);
      return { cursor: newest, touched: new Set(items.map((t) => t.videoId).filter((id) => ids.has(id))) };
    },
  };
}

/**
 * Where the network has no feed of comments but lists its posts with how many comments each has
 * (dev.to, Instagram): a count that moved since the last run says the post has comments to read.
 * The cursor is the counts as last seen, of the posts asked about.
 */
export function countFeed(counts: () => Promise<Map<string, number>>): CommentFeed {
  return {
    async changes(posts, cursor) {
      const now = await counts();
      const before = cursor === undefined ? undefined : (JSON.parse(cursor) as Record<string, number>);
      const touched = new Set(posts.map((p) => p.externalId).filter((id) => before === undefined || (now.get(id) ?? 0) !== (before[id] ?? 0)));
      const seen = Object.fromEntries(posts.map((p) => [p.externalId, now.get(p.externalId) ?? 0]));
      return { cursor: JSON.stringify(seen), touched };
    },
  };
}

/** GitHub Discussions: every discussion's whole thread through nodes(ids:), one query per twenty */
export function threadsFeed(many: (ids: string[]) => Promise<Map<string, Comment[]>>): CommentFeed {
  return {
    async changes(posts) {
      return { cursor: undefined, touched: new Set(), comments: await many(posts.map((p) => p.externalId)) };
    },
  };
}
