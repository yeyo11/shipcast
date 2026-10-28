import { Discord } from '@shipcast/connectors';
import { discord } from '@shipcast/schema';
import { channelAdapter } from './adapter.ts';

/** Discord: one channel's webhook; posts, edits and deletes through it */
export const discordAdapter = channelAdapter({
  definition: discord,
  connect: {
    kind: 'account',
    network: {
      id: 'discord',
      auth: 'form',
      fields: [{ key: 'webhookUrl', label: 'Webhook URL', secret: true }],
      permissions: ['Posts to one channel through its webhook'],
      howTo: 'Discord → the channel’s settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.',
      env: [{ name: 'DISCORD_WEBHOOK_URL', key: 'webhookUrl', secret: true, how: 'Server Settings > Integrations > Webhooks (https://support.discord.com/hc/en-us/articles/228383668)' }],
      build: ({ need, fetch }) => {
        const connector = new Discord({ webhookUrl: need('webhookUrl'), fetch });
        return { connector, check: () => connector.check() };
      },
    },
  },
  publisher: (c) => c,
  editor: (c) => c,
});
