import { Devto } from '@shipcast/connectors';
import { devto } from '@shipcast/schema';
import { channelAdapter } from './adapter.ts';

/** dev.to: an API key; it publishes the English article, edits and unpublishes it, reads its numbers and comments */
export const devtoAdapter = channelAdapter({
  definition: devto,
  connect: {
    kind: 'account',
    network: {
      id: 'devto',
      auth: 'form',
      fields: [{ key: 'apiKey', label: 'API key', secret: true }],
      permissions: ['Publishes the English article with the blog as its canonical URL', 'Reads its views, reactions and comments'],
      howTo: 'dev.to → Settings → Extensions → DEV Community API Keys → Generate API Key.',
      env: [{ name: 'DEVTO_API_KEY', key: 'apiKey', secret: true, how: 'https://dev.to/settings/extensions (DEV Community API Keys)' }],
      build: ({ need, fetch }) => {
        const connector = new Devto({ apiKey: need('apiKey'), fetch });
        return { connector, check: () => connector.check(), profileStats: () => connector.profileStats(), profile: () => connector.profile() };
      },
    },
  },
  publisher: (c) => c,
  editor: (c) => c,
  metrics: (c) => c,
  // Forem has no endpoint to write a comment: dev.to's are read only
  comments: (c) => ({ reader: c }),
});
