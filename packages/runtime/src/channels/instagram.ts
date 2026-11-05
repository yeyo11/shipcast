import { countFeed } from './feeds.ts';
import { ConnectorError, exchangeInstagramCode, facebookDialogUrl, Instagram, instagramAuthorizeUrl, unifiedAccess } from '@shipcast/connectors';
import { instagram } from '@shipcast/schema';
import { channelAdapter, MissingField } from './adapter.ts';

/** Where a refreshed Instagram token is kept when it came from `.env`: in the registry, never in a file in the repo. */
export const INSTAGRAM_TOKEN_KEY = 'instagram-token';
export const INSTAGRAM_REFRESHED_KEY = 'instagram-token-refreshed-at';

/** Meta's long-lived tokens last 60 days: each is refreshed at 30 */
const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;

/**
 * The login an account was connected with. An account from before the variants has no `login`: it
 * came through Instagram Login, and stays on it whatever Settings says now.
 */
export function instagramLoginOf(settings: Record<string, string>): 'instagram' | 'unified' | 'facebook' {
  const login = settings.login;
  return login === 'unified' || login === 'facebook' ? login : 'instagram';
}

/** Instagram: Instagram Login or Unified Login with the owner's Meta app; the carousel, the story, its comments, their numbers and the profile */
export const instagramAdapter = channelAdapter({
  definition: instagram,
  connect: {
    kind: 'account',
    network: {
      id: 'instagram',
      auth: 'oauth',
      fields: [],
      // Instagram Login asks for the instagram_business_* family, Unified Login for the instagram_* one
      permissions: [
        'Publishes the carousel and the story (instagram_business_content_publish or instagram_content_publish)',
        'Comments on its own post (instagram_business_manage_comments or instagram_manage_comments)',
        'Reads its posts’ and stories’ views, reach and interactions, and the account’s (instagram_business_manage_insights or instagram_manage_insights)',
        'Reads the profile’s name, bio, website and picture for a review (instagram_business_basic or instagram_basic)',
      ],
      howTo:
        "A professional (Creator or Business) account. Set your Meta app's Instagram setup in Settings. Instagram Login: Shipcast sends you to Instagram to authorise it; the token is renewed every 30 days. Unified Login: create a configuration in Instagram → API setup with Unified login whose token never expires, and set its id and the Meta app id and secret in Settings.",
      env: [
        { name: 'INSTAGRAM_USER_ID', key: 'userId', secret: false },
        { name: 'INSTAGRAM_ACCESS_TOKEN', key: 'accessToken', secret: true },
      ],
      oauth: {
        setting: 'instagramLogin',
        fallback: 'instagram',
        variants: {
          instagram: {
            label: 'Instagram Login',
            app: { id: 'instagram', term: 'app', name: 'Instagram' },
            authorizeUrl: (app, redirectUri, state) => instagramAuthorizeUrl(app.clientId, redirectUri, state),
            exchange: async (app, redirectUri, code, http) => {
              const token = await exchangeInstagramCode({ appId: app.clientId, appSecret: app.clientSecret }, redirectUri, code, http);
              return [{ credentials: { settings: { userId: token.userId, refreshedAt: new Date().toISOString() }, secrets: { accessToken: token.accessToken } } }];
            },
            errorParams: ['error_description', 'error_reason'],
          },
          unified: {
            label: 'Unified Login',
            app: { id: 'meta', term: 'app', name: 'Meta' },
            config: 'instagramConfigId',
            authorizeUrl: (app, redirectUri, state) => {
              // An empty config_id would send the owner to a Meta error page that does not say why
              if (!app.configId) throw new MissingField('Unified Login needs the Instagram configuration id in Settings');
              return facebookDialogUrl({ appId: app.clientId, configId: app.configId }, redirectUri, state);
            },
            exchange: async (app, redirectUri, code, http) => {
              const access = await unifiedAccess({ appId: app.clientId, appSecret: app.clientSecret }, redirectUri, code, http);
              if (access.instagram.length === 0) {
                throw new ConnectorError('Meta', 'the sign-in shared no Instagram professional account: choose at least one when Meta asks');
              }
              // One business integration token reaches every account shared with it; it never expires
              return access.instagram.map((account) => ({
                label: account.username ? `@${account.username}` : account.id,
                credentials: { settings: { login: 'unified', userId: account.id, businessId: access.businessId }, secrets: { accessToken: access.accessToken } },
              }));
            },
            errorParams: ['error_description', 'error_reason', 'error_message'],
          },
        },
      },
      refresh: {
        everyMs: THIRTY_DAYS_MS,
        // Only Instagram Login's tokens expire: a Unified Login token is a system user's, which does not
        refresher: (settings, accessToken, http) =>
          settings.userId && instagramLoginOf(settings) === 'instagram' ? new Instagram({ userId: settings.userId, accessToken, fetch: http }) : undefined,
        envToken: { tokenKey: INSTAGRAM_TOKEN_KEY, refreshedKey: INSTAGRAM_REFRESHED_KEY },
      },
      build: ({ need, get, fetch, cache }) => {
        const login = get('login');
        const host = instagramLoginOf(login ? { login } : {}) === 'instagram' ? 'instagram' : 'facebook';
        const connector = new Instagram({ userId: need('userId'), accessToken: need('accessToken'), host, fetch, ...(cache && { cache }) });
        return { connector, check: () => connector.check(), profileStats: () => connector.profileStats(), profile: () => connector.profile(), audienceHours: () => connector.audienceHours() };
      },
    },
  },
  publisher: (c) => c,
  // A story's numbers are not a post's: its own set, read while Meta keeps them (24 hours)
  metrics: (c) => ({ metrics: (id: string, kind?: string) => (kind === instagram.metrics.expiring.kind ? c.storyMetrics(id) : c.metrics(id)) }),
  comments: (c) => ({ reader: c, replier: c, feed: countFeed(() => c.commentCounts()) }),
});
