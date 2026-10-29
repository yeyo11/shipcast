import { batchReader } from '@shipcast/engine';
import { exchangeRedditCode, Reddit, redditAuthorizeUrl } from '@shipcast/connectors';
import { reddit, track } from '@shipcast/schema';
import { channelAdapter } from './adapter.ts';

/** Reddit: the owner's approved Reddit app; one text post per subreddit, found again when an answer was lost, and its numbers */
export const redditAdapter = channelAdapter({
  definition: reddit,
  connect: {
    kind: 'account',
    network: {
      id: 'reddit',
      auth: 'oauth',
      fields: [],
      permissions: [
        'Publishes one text post per subreddit in launch.yml, linking the article (submit)',
        'Deletes a post when you ask (edit)',
        'Lists your own submissions, to find a post whose answer was lost instead of posting it twice (history)',
        'Reads each post’s score, comments, crossposts and upvote ratio (read)',
        'Reads your name, profile, picture and karma (identity)',
      ],
      howTo: 'Needs your Reddit app (a "web app" at reddit.com/prefs/apps, whose API access Reddit has approved), its client id and secret set in Settings, and its redirect uri set to this app’s /auth/reddit/callback. Shipcast sends you to Reddit to authorise it once; the account stays connected.',
      oauth: {
        app: { term: 'client', name: 'Reddit' },
        authorizeUrl: (app, redirectUri, state) => redditAuthorizeUrl(app.clientId, redirectUri, state),
        exchange: async (app, redirectUri, code, http) => {
          const token = await exchangeRedditCode(app, redirectUri, code, http);
          return {
            label: `u/${token.username}`,
            // The app's client goes with the account: its refresh token is only good with that app
            credentials: { settings: { username: token.username, clientId: app.clientId }, secrets: { refreshToken: token.refreshToken, clientSecret: app.clientSecret } },
          };
        },
        errorParams: ['error'],
      },
      build: ({ need, fetch }) => {
        // The app's client is kept with the account: the refresh token is only good with the app that issued it
        const connector = new Reddit({ clientId: need('clientId'), clientSecret: need('clientSecret'), refreshToken: need('refreshToken'), username: need('username'), fetch });
        return { connector, check: () => connector.check(), profileStats: () => connector.profileStats(), profile: () => connector.profile() };
      },
    },
  },
  // Each subreddit's post says which community the visit came from
  publisher: (c) => ({
    publish: (post, tracking) => c.publish({ ...post, text: track('reddit', post.text, tracking, post.subreddit) }),
    find: (post, since) => c.find(post, since),
  }),
  editor: (c) => c,
  // A subreddit's post is a piece of its own: up to 100 of them a call
  metrics: (c) => ({ metrics: (id: string) => c.metrics(id), read: batchReader((ids) => c.metricsMany(ids)).read }),
});
