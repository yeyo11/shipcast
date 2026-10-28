import { batchReader } from '@shipcast/engine';
import { Mastodon } from '@shipcast/connectors';
import { mastodon } from '@shipcast/schema';
import { channelAdapter } from './adapter.ts';

/** `https://mastodon.social/@yeyo11` → `https://mastodon.social` */
export function mastodonInstance(profile: string | undefined): string | undefined {
  return profile ? new URL(profile).origin : undefined;
}

/**
 * Mastodon: an instance and a token. Its sign-in registers Shipcast on the instance the owner names
 * (apps/web/src/server/channels.server.ts), so it has no app in Settings and no `oauth` spec here.
 */
export const mastodonAdapter = channelAdapter({
  definition: mastodon,
  connect: {
    kind: 'account',
    network: {
      id: 'mastodon',
      auth: 'oauth',
      fields: [
        { key: 'instance', label: 'Instance', secret: false, placeholder: 'https://mastodon.social' },
        {
          key: 'accessToken',
          label: 'Access token',
          secret: true,
          optional: true,
          help: 'Only to paste one instead of authorising: Preferences → Development → an app with read and write scopes',
        },
      ],
      permissions: [
        'Posts a public status with an image (write:statuses, write:media)',
        'Reads its favourites, boosts and replies (read:statuses)',
        'Changes the profile’s name, bio and fields when you apply a review’s proposal (write:accounts)',
      ],
      howTo: 'Name your instance: Shipcast registers itself there and sends you to authorise it. Or paste an access token.',
      env: [
        // The instance can come from brand.yml's profile link instead
        { name: 'MASTODON_INSTANCE', key: 'instance', secret: false, fallback: (brand) => mastodonInstance(brand.handles.mastodon), how: 'your server, like mastodon.social' },
        {
          name: 'MASTODON_ACCESS_TOKEN',
          key: 'accessToken',
          secret: true,
          how: 'https://<your server>/settings/applications (New application; scopes read, write:statuses, write:media)',
        },
      ],
      build: ({ need, fetch, cache }) => {
        const connector = new Mastodon({ instance: need('instance'), accessToken: need('accessToken'), fetch, ...(cache && { cache }) });
        return { connector, check: () => connector.check(), profileStats: () => connector.profileStats(), profile: () => connector.profile(), editProfile: (e) => connector.editProfile(e) };
      },
    },
  },
  publisher: (c) => c,
  editor: (c) => c,
  // One piece a call for the six-hourly reads as they were; many per call for the hourly ones
  metrics: (c) => ({ metrics: (id: string) => c.metrics(id), read: batchReader((ids) => c.metricsMany(ids)).read }),
  comments: (c) => ({ reader: c, replier: c }),
});
