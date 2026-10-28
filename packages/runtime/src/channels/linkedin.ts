import { exchangeLinkedInCode, LinkedIn, linkedinAuthorizeUrl } from '@shipcast/connectors';
import { linkedin } from '@shipcast/schema';
import { channelAdapter } from './adapter.ts';

/** LinkedIn: the owner's LinkedIn app; shares the article on the personal profile and deletes it */
export const linkedinAdapter = channelAdapter({
  definition: linkedin,
  connect: {
    kind: 'account',
    network: {
      id: 'linkedin',
      auth: 'oauth',
      fields: [],
      permissions: [
        'Publishes a post on your personal profile sharing the article, and deletes it when you ask (w_member_social)',
        'Reads your name and picture to show the account (openid, profile)',
        'No numbers and no comments: LinkedIn keeps them behind its Community Management API, for approved companies only',
      ],
      howTo: 'Needs your LinkedIn app with Sign In with LinkedIn using OpenID Connect and Share on LinkedIn, its client id and secret set in Settings. The token lasts 60 days; connect again when it runs out.',
      oauth: {
        app: { term: 'client', name: 'LinkedIn' },
        authorizeUrl: (app, redirectUri, state) => linkedinAuthorizeUrl(app.clientId, redirectUri, state),
        exchange: async (app, redirectUri, code, http) => {
          const token = await exchangeLinkedInCode(app, redirectUri, code, http);
          return {
            ...(token.name && { label: token.name }),
            // No refresh token for most apps: the expiry is kept so the account says when to connect again
            credentials: { settings: { personId: token.personId, expiresAt: new Date(Date.now() + token.expiresIn * 1000).toISOString() }, secrets: { accessToken: token.accessToken } },
          };
        },
        errorParams: ['error_description', 'error'],
      },
      build: ({ need, get, fetch }) => {
        const connector = new LinkedIn({ personId: need('personId'), accessToken: need('accessToken'), expiresAt: get('expiresAt'), fetch });
        return { connector, check: () => connector.check() };
      },
    },
  },
  // No metrics: a member's numbers need LinkedIn's Community Management API
  publisher: (c) => c,
  editor: (c) => c,
});
