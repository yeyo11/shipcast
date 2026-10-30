import { ConnectorError, Telegram } from '@shipcast/connectors';
import { telegram, trackWithinLimit } from '@shipcast/schema';
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
      permissions: ['Posts to the channel', 'Reads its posts’ reactions from the changes Telegram tells the bot (an admin of the channel)', 'Tells you when drafts are waiting, published or failed', 'Changes the channel’s title and description when you apply a review’s proposal, and its photo to brand.yml’s avatar when you ask (the “Change channel info” admin right)'],
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
  // Telegram counts a link's every character: a text the tags would push over the limit keeps its ?ref=
  publisher: (c) => ({ publish: (post, tracking) => c.publish({ ...post, text: trackWithinLimit('telegram', post.text, tracking) }) }),
  // An edit's text is tagged as the post's was, within the same limit
  editor: (c) => ({ edit: (id, e, tracking) => c.edit(id, { ...e, text: trackWithinLimit('telegram', e.text, tracking) }), delete: (id) => c.delete(id) }),
  // Only from the changes Telegram pushed, every post at once, each page kept before it is confirmed:
  // a post with none kept its reactions, and one never told about has no reading. There is no read of
  // one post, since reading the changes for one would confirm, and lose, every other post's
  metrics: (c) => ({
    metrics: async () => {
      throw new ConnectorError('Telegram', 'a post’s reactions are only read from the changes Telegram pushed, for every post at once', 400, false);
    },
    pushed: (ids: string[], store) => c.reactions(ids, store),
  }),
  // The owner's notices go only to their own chat with the bot; with none set there is no notifier,
  // never the channel a launch publishes to, which is public
  notifier: (_connection, credentials, http) => {
    const chat = credentials.settings.notifyChatId?.trim();
    return chat ? new Telegram({ botToken: credentials.secrets.botToken!, chatId: chat, fetch: http }) : undefined;
  },
});
