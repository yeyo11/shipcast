import { exchangeInstagramCode, Instagram, instagramAuthorizeUrl } from '@shipcast/connectors';
import { instagram } from '@shipcast/schema';
import { channelAdapter } from './adapter.ts';

/** Where a refreshed Instagram token is kept when it came from `.env`: in the registry, never in a file in the repo. */
export const INSTAGRAM_TOKEN_KEY = 'instagram-token';
export const INSTAGRAM_REFRESHED_KEY = 'instagram-token-refreshed-at';

/** Meta's long-lived tokens last 60 days: each is refreshed at 30 */
const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;

/** Instagram: Instagram Login with the owner's Meta app; the carousel, the story, its comments and its reach */
export const instagramAdapter = channelAdapter({
  definition: instagram,
  connect: {
    kind: 'account',
    network: {
      id: 'instagram',
      auth: 'oauth',
      fields: [],
      permissions: [
        'Publishes the carousel and the story (instagram_business_content_publish)',
        'Comments on its own post (instagram_business_manage_comments)',
        'Reads reach and interactions (instagram_business_manage_insights)',
      ],
      howTo: 'A professional (Creator or Business) account. Shipcast sends you to Instagram to authorise it; the token is renewed every 30 days.',
      env: [
        { name: 'INSTAGRAM_USER_ID', key: 'userId', secret: false },
        { name: 'INSTAGRAM_ACCESS_TOKEN', key: 'accessToken', secret: true },
      ],
      oauth: {
        app: { term: 'app', name: 'Instagram' },
        authorizeUrl: (app, redirectUri, state) => instagramAuthorizeUrl(app.clientId, redirectUri, state),
        exchange: async (app, redirectUri, code, http) => {
          const token = await exchangeInstagramCode({ appId: app.clientId, appSecret: app.clientSecret }, redirectUri, code, http);
          return { credentials: { settings: { userId: token.userId, refreshedAt: new Date().toISOString() }, secrets: { accessToken: token.accessToken } } };
        },
        errorParams: ['error_description', 'error_reason'],
      },
      refresh: {
        everyMs: THIRTY_DAYS_MS,
        refresher: (settings, accessToken, http) => (settings.userId ? new Instagram({ userId: settings.userId, accessToken, fetch: http }) : undefined),
        envToken: { tokenKey: INSTAGRAM_TOKEN_KEY, refreshedKey: INSTAGRAM_REFRESHED_KEY },
      },
      build: ({ need, fetch, cache }) => {
        const connector = new Instagram({ userId: need('userId'), accessToken: need('accessToken'), fetch, ...(cache && { cache }) });
        return { connector, check: () => connector.check(), profileStats: () => connector.profileStats(), audienceHours: () => connector.audienceHours() };
      },
    },
  },
  publisher: (c) => c,
  metrics: (c) => c,
  comments: (c) => ({ reader: c, replier: c }),
});
