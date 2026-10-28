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
  metrics: (c) => c,
  comments: (c) => ({ reader: c, replier: c }),
});
