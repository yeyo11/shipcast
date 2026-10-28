import { Hashnode } from '@shipcast/connectors';
import { hashnode } from '@shipcast/schema';
import { channelAdapter } from './adapter.ts';

/** Hashnode: a personal access token; republishes the English article, edits and deletes it, reads its numbers */
export const hashnodeAdapter = channelAdapter({
  definition: hashnode,
  connect: {
    kind: 'account',
    network: {
      id: 'hashnode',
      auth: 'form',
      fields: [
        { key: 'token', label: 'Personal access token', secret: true },
        { key: 'publicationHost', label: 'Publication host', secret: false, placeholder: 'name.hashnode.dev' },
      ],
      permissions: ['Republishes the English article with the blog as its original URL', 'Reads views, reactions and comments'],
      howTo: 'Hashnode → Account settings → Developer → Generate new token. Hashnode’s API may need the publication on its Pro plan.',
      env: [
        { name: 'HASHNODE_TOKEN', key: 'token', secret: true, how: 'https://hashnode.com/settings/developer' },
        { name: 'HASHNODE_PUBLICATION_HOST', key: 'publicationHost', secret: false, optional: true, how: 'your publication, like you.hashnode.dev' },
      ],
      build: ({ need, get, fetch }) => {
        const connector = new Hashnode({ token: need('token'), publicationHost: get('publicationHost'), fetch });
        return { connector, check: () => connector.check(), profileStats: () => connector.profileStats(), profile: () => connector.profile() };
      },
    },
  },
  publisher: (c) => c,
  editor: (c) => c,
  metrics: (c) => c,
});
