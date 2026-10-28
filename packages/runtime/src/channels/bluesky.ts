import { blueskyFeed } from './feeds.ts';
import { batchReader } from '@shipcast/engine';
import { Bluesky } from '@shipcast/connectors';
import { bluesky } from '@shipcast/schema';
import { channelAdapter } from './adapter.ts';

/** `https://bsky.app/profile/yeyo11.bsky.social` → `yeyo11.bsky.social` */
export function blueskyHandle(profile: string | undefined): string | undefined {
  return profile ? /\/profile\/([^/?#]+)/.exec(profile)?.[1] : undefined;
}

/** Bluesky: a handle and an app password; posts with a link card, deletes, reads and answers replies */
export const blueskyAdapter = channelAdapter({
  definition: bluesky,
  connect: {
    kind: 'account',
    network: {
      id: 'bluesky',
      auth: 'form',
      fields: [
        { key: 'handle', label: 'Handle', secret: false, placeholder: 'name.bsky.social' },
        { key: 'appPassword', label: 'App password', secret: true, help: 'Never the account password' },
      ],
      permissions: ['Posts with a link card', 'Reads likes, reposts and replies (public)', 'Changes the profile’s name and description when you apply a review’s proposal'],
      howTo: 'Bluesky → Settings → Privacy and security → App passwords → Add App Password.',
      env: [
        // The handle can come from brand.yml's profile link instead
        { name: 'BLUESKY_HANDLE', key: 'handle', secret: false, fallback: (brand) => blueskyHandle(brand.handles.bluesky), how: 'your handle, like you.bsky.social' },
        { name: 'BLUESKY_APP_PASSWORD', key: 'appPassword', secret: true, how: 'https://bsky.app/settings/app-passwords' },
      ],
      build: ({ need, fetch, cache }) => {
        const connector = new Bluesky({ identifier: need('handle'), appPassword: need('appPassword'), fetch, ...(cache && { cache }) });
        return { connector, check: () => connector.check(), profileStats: () => connector.profileStats(), profile: () => connector.profile(), editProfile: (e) => connector.editProfile(e) };
      },
    },
  },
  publisher: (c) => c,
  editor: (c) => c,
  // One piece a call for the six-hourly reads as they were; many per call for the hourly ones
  metrics: (c) => ({ metrics: (id: string) => c.metrics(id), read: batchReader((ids) => c.metricsMany(ids)).read }),
  comments: (c) => ({ reader: c, replier: c, feed: blueskyFeed(c) }),
});
