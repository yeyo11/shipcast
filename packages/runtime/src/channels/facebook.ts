import { ConnectorError, exchangeFacebookCode, FacebookPage, facebookDialogUrl, listPages, longLivedUserToken } from '@shipcast/connectors';
import { textPostStrategy, type ChangeEditor, type TextPostPublisher } from '@shipcast/engine';
import { articleLink, facebook, leadLanguage, trackUrl } from '@shipcast/schema';
import { channelAdapter, MissingField } from './adapter.ts';

/** Facebook: a Page of the owner's, through Facebook Login for Business on the Meta app; its link posts, their comments and numbers, the Page's */
export const facebookAdapter = channelAdapter({
  definition: facebook,
  connect: {
    kind: 'account',
    network: {
      id: 'facebook',
      auth: 'oauth',
      fields: [],
      permissions: [
        'Lists the Pages you share, to connect each one as an account (pages_show_list), including those a business portfolio owns (business_management)',
        'Publishes a post with the article as its link card on the Page, edits it and deletes it when you ask (pages_manage_posts)',
        'Reads the comments on its posts, the Page’s followers and likes, and its About text and picture (pages_read_engagement)',
        'Answers a comment as the Page when you approve (pages_manage_engagement)',
        'Reads the posts’ reach, clicks and reactions and the Page’s follows and engagement (read_insights)',
      ],
      howTo:
        'Add the Manage everything on your Page use case to your Meta app, create a Facebook Login for Business configuration with a User access token and the Pages permissions, and set its id and the Meta app id and secret in Settings.',
      oauth: {
        app: { id: 'meta', term: 'app', name: 'Meta' },
        config: 'facebookConfigId',
        authorizeUrl: (app, redirectUri, state) => {
          // An empty config_id would send the owner to a Meta error page that does not say why
          if (!app.configId) throw new MissingField('Facebook Login needs the Facebook configuration id in Settings');
          return facebookDialogUrl({ appId: app.clientId, configId: app.configId }, redirectUri, state);
        },
        exchange: async (app, redirectUri, code, http) => {
          const credentials = { appId: app.clientId, appSecret: app.clientSecret };
          const short = await exchangeFacebookCode(credentials, redirectUri, code, http);
          const long = await longLivedUserToken(credentials, short.accessToken, http);
          const pages = await listPages(long.accessToken, http);
          if (pages.length === 0) throw new ConnectorError('Meta', 'the sign-in shared no Facebook Page: choose at least one when Meta asks');
          // The Page token of a long-lived user token does not expire, so these accounts need no refresher
          return pages.map((page) => ({ label: page.name || page.pageId, credentials: { settings: { pageId: page.pageId }, secrets: { accessToken: page.pageToken } } }));
        },
        errorParams: ['error_description', 'error_reason', 'error_message'],
      },
      build: ({ need, fetch, cache }) => {
        const connector = new FacebookPage({ pageId: need('pageId'), accessToken: need('accessToken'), ...(fetch && { fetch }), ...(cache && { cache }) });
        return { connector, check: () => connector.check(), profileStats: () => connector.profileStats(), profile: () => connector.profile() };
      },
    },
  },
  // The link is the card, not part of the text, so its tags never count against the text's limit
  publisher: (c: FacebookPage): TextPostPublisher => ({ publish: (post, tracking) => c.publish({ ...post, link: trackUrl('facebook', post.link, tracking) }) }),
  // brand.yml's languages.facebook picks the article the Page links; the lead one where the pack lacks it
  strategy: textPostStrategy(facebook, ({ pack, brand }) => articleLink(pack, brand.site, brand.languages.facebook, leadLanguage(pack.article, brand))),
  editor: (c: FacebookPage): ChangeEditor => ({
    // Only the message changes in place: the link card is the article's, fixed when it was posted
    edit: async (id, changes) => {
      if (changes.text !== undefined) await c.edit(id, { text: changes.text });
    },
    delete: (id) => c.delete(id),
  }),
  metrics: (c: FacebookPage) => ({ metrics: (id: string) => c.metrics(id) }),
  comments: (c: FacebookPage) => ({ reader: c, replier: c }),
});
