import { batchReader } from '@shipcast/engine';
import { Discord } from '@shipcast/connectors';
import { discord, trackUrl, trackWithinLimit } from '@shipcast/schema';
import { channelAdapter } from './adapter.ts';

/** Discord: one channel's webhook; posts, edits and deletes through it */
export const discordAdapter = channelAdapter({
  definition: discord,
  connect: {
    kind: 'account',
    network: {
      id: 'discord',
      auth: 'form',
      fields: [
        { key: 'webhookUrl', label: 'Webhook URL', secret: true },
        {
          key: 'inviteCode',
          label: 'Invite link',
          secret: false,
          optional: true,
          placeholder: 'https://discord.gg/…',
          help: 'A permanent invite to the server, only to count its members: a webhook does not see its server',
        },
      ],
      permissions: ['Posts to one channel through its webhook', 'Reads its messages’ reactions back through the same webhook', 'Counts the server’s members through its invite, when one is given', 'Changes the webhook’s name, and its picture to brand.yml’s avatar, when you ask'],
      howTo: 'Discord → the channel’s settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.',
      // The invite is set on the account's form only: .env predates it and the Action reads no numbers
      env: [{ name: 'DISCORD_WEBHOOK_URL', key: 'webhookUrl', secret: true, how: 'Server Settings > Integrations > Webhooks (https://support.discord.com/hc/en-us/articles/228383668)' }],
      build: ({ need, get, fetch }) => {
        const connector = new Discord({ webhookUrl: need('webhookUrl'), fetch });
        const invite = get('inviteCode');
        return {
          connector,
          check: () => connector.check(),
          profile: () => connector.profile(),
          editProfile: (e) => connector.editProfile(e),
          ...(invite && { profileStats: () => connector.profileStats(invite) }),
        };
      },
    },
  },
  // The message keeps its ?ref= when the tags would push it over the limit; the embed's link has none
  publisher: (c) => ({
    publish: (post, tracking) =>
      c.publish({ ...post, content: trackWithinLimit('discord', post.content, tracking), ...(post.embed && { embed: { ...post.embed, url: trackUrl('discord', post.embed.url, tracking) } }) }),
  }),
  // An edit's message is tagged as the post's was, within the same limit
  editor: (c) => ({ edit: (id, e, tracking) => c.edit(id, { content: trackWithinLimit('discord', e.content, tracking) }), delete: (id) => c.delete(id) }),
  // One message a call, every due one in a round; a message deleted on Discord is left out
  metrics: (c) => ({ metrics: (id: string) => c.metrics(id), read: batchReader((ids) => c.metricsMany(ids)).read }),
});
