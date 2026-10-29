import { exchangeThreadsCode, Threads, threadsAuthorizeUrl } from '@shipcast/connectors';
import { threads, trackWithinLimit } from '@shipcast/schema';
import { batchReader } from '@shipcast/engine';
import { channelAdapter } from './adapter.ts';

/** Meta's long-lived tokens last 60 days: each is refreshed at 30 */
const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;

/** Threads: the Threads use case of the owner's Meta app; posts, deletes, replies and insights */
export const threadsAdapter = channelAdapter({
  definition: threads,
  connect: {
    kind: 'account',
    network: {
      id: 'threads',
      auth: 'oauth',
      fields: [],
      permissions: [
        'Publishes a post with the launch image (threads_content_publish) and deletes it when you ask (threads_delete)',
        'Reads the replies and answers them when you approve (threads_read_replies, threads_manage_replies)',
        'Reads views, likes, replies and reposts, the clicks on its links and the profile’s views (threads_manage_insights)',
        'Reads the profile’s name, bio and picture for a review (threads_basic)',
      ],
      howTo: 'Needs your Meta app’s Threads use case, its app id and secret set in Settings. Shipcast sends you to Threads to authorise it; the token is renewed every 30 days.',
      oauth: {
        app: { term: 'app', name: 'Threads' },
        authorizeUrl: (app, redirectUri, state) => threadsAuthorizeUrl(app.clientId, redirectUri, state),
        exchange: async (app, redirectUri, code, http) => {
          const token = await exchangeThreadsCode({ appId: app.clientId, appSecret: app.clientSecret }, redirectUri, code, http);
          return { credentials: { settings: { userId: token.userId, refreshedAt: new Date().toISOString() }, secrets: { accessToken: token.accessToken } } };
        },
        errorParams: ['error_description', 'error_reason'],
      },
      refresh: {
        everyMs: THIRTY_DAYS_MS,
        refresher: (settings, accessToken, http) => (settings.userId ? new Threads({ userId: settings.userId, accessToken, fetch: http }) : undefined),
      },
      build: ({ need, fetch, cache }) => {
        const connector = new Threads({ userId: need('userId'), accessToken: need('accessToken'), fetch, ...(cache && { cache }) });
        return { connector, check: () => connector.check(), profileStats: () => connector.profileStats(), profile: () => connector.profile() };
      },
    },
  },
  // Threads counts a link's every character: a text the tags would push over the limit keeps its ?ref=
  publisher: (c) => ({ publish: (post, tracking) => c.publish({ ...post, text: trackWithinLimit('threads', post.text, tracking) }) }),
  editor: (c) => c,
  // Every due post at once, so the account's link clicks are asked once for all of them
  metrics: (c) => ({ metrics: (id: string) => c.metrics(id), read: batchReader((ids) => c.metricsMany(ids)).read }),
  // No feed: Threads lists no replies since a cursor nor a reply count per post, so each post is read
  comments: (c) => ({ reader: c, replier: c }),
});
