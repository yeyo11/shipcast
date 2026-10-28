import { threadsFeed } from './feeds.ts';
import { batchReader } from '@shipcast/engine';
import { GitHubDiscussions } from '@shipcast/connectors';
import { githubDiscussions } from '@shipcast/schema';
import { channelAdapter } from './adapter.ts';

/**
 * GitHub Discussions: no account to connect; the engine's own GitHub access (the App's installation)
 * posts in the launched repo, edits and deletes there, and reads and answers the comments.
 */
export const githubDiscussionsAdapter = channelAdapter({
  definition: githubDiscussions,
  connect: { kind: 'engine', configured: 'github discussions', build: ({ auth, fetch }) => new GitHubDiscussions({ auth, ...(fetch && { fetch }) }) },
  publisher: (c) => c,
  editor: (c) => c,
  // One piece a call for the six-hourly reads as they were; many per call for the hourly ones
  metrics: (c) => ({ metrics: (id: string) => c.metrics(id), read: batchReader((ids) => c.metricsMany(ids)).read }),
  comments: (c) => ({ reader: c, replier: c, feed: threadsFeed((ids) => c.commentsMany(ids)) }),
});
