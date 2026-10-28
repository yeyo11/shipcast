import { Telegram } from '@shipcast/connectors';
import { telegram } from '@shipcast/schema';
import { channelAdapter } from './adapter.ts';

/** Telegram: a bot that is an admin of the channel; posts, edits and deletes there, and tells the owner what is waiting */
export const telegramAdapter = channelAdapter({
  definition: telegram,
  connect: {
    kind: 'account',
    network: {
      id: 'telegram',
      auth: 'form',
      fields: [
        { key: 'botToken', label: 'Bot token', secret: true },
        { key: 'chatId', label: 'Chat or channel', secret: false, placeholder: '@channel or -100…', help: 'Where posts go; notifications go there too unless a notification chat is set' },
        { key: 'notifyChatId', label: 'Notification chat', secret: false, optional: true, help: 'Your private chat with the bot, for “drafts are waiting” messages' },
      ],
      permissions: ['Posts to the channel', 'Tells you when drafts are waiting, published or failed', 'Changes the channel’s title and description when you apply a review’s proposal (the “Change channel info” admin right)'],
      howTo: 'Talk to @BotFather, send /newbot and copy the token; add the bot as an admin of the channel.',
      env: [
        { name: 'TELEGRAM_BOT_TOKEN', key: 'botToken', secret: true, how: 'https://t.me/BotFather (/newbot), then add the bot to your channel as an admin' },
        { name: 'TELEGRAM_CHAT_ID', key: 'chatId', secret: false, how: 'your channel, like @yourchannel' },
        { name: 'TELEGRAM_NOTIFY_CHAT_ID', key: 'notifyChatId', secret: false, optional: true, notInAction: true },
      ],
      build: ({ need, fetch }) => {
        const connector = new Telegram({ botToken: need('botToken'), chatId: need('chatId'), fetch });
        return { connector, check: () => connector.check(), profileStats: () => connector.profileStats(), profile: () => connector.profile(), editProfile: (e) => connector.editProfile(e) };
      },
    },
  },
  publisher: (c) => c,
  editor: (c) => c,
  // Notices go to the owner's own chat with the bot when one is set, not to the public channel
  notifier: (connection, credentials, http) => {
    const chat = credentials.settings.notifyChatId?.trim();
    return chat ? new Telegram({ botToken: credentials.secrets.botToken!, chatId: chat, fetch: http }) : connection.connector;
  },
});
