import { ConnectorError, json, checkProblem, okCheck, statsOf, type Check, type Deletable, type Editable, type Metrics, type ProfileStats, type Published } from './http.ts';

export interface TelegramEdit {
  /** The message's text, or its caption when it is a photo */
  text: string;
  /** A new photo in place of the one it has; only a photo message can change its photo */
  imageUrl?: string;
  parseMode?: 'HTML' | 'MarkdownV2';
}

/** `<chat>:<message>` as publish records it; a chat id never holds a colon (-100123 or @name) */
function messageOf(externalId: string): { chat_id: string; message_id: number } {
  const at = externalId.lastIndexOf(':');
  const messageId = Number(externalId.slice(at + 1));
  if (at <= 0 || !Number.isInteger(messageId)) throw new ConnectorError('Telegram', `${externalId} is not a <chat>:<message> id`, 400);
  return { chat_id: externalId.slice(0, at), message_id: messageId };
}

/** What the Bot API said, for telling one 400 from another */
const said = (error: unknown, words: RegExp) => error instanceof ConnectorError && error.status === 400 && words.test(error.message);

export interface TelegramPost {
  /** 4096 characters at most; with an image it becomes the caption, which stops at 1024 */
  text: string;
  imageUrl?: string;
  parseMode?: 'HTML' | 'MarkdownV2';
}

interface Answer<T> {
  ok: boolean;
  result: T;
}

interface SentMessage {
  message_id: number;
  chat: { id: number; username?: string };
}

/** The post's own link: the username's for a public chat, the internal id's for a private one (-100123 is /c/123). */
function messageUrl(chatId: string, chat: SentMessage['chat'], messageId: number): string {
  const username = chat.username ?? (chatId.startsWith('@') ? chatId.slice(1) : undefined);
  if (username) return `https://t.me/${username}/${messageId}`;
  return `https://t.me/c/${String(chat.id).replace(/^-100/, '')}/${messageId}`;
}

/**
 * Telegram through the Bot API: a post to a channel or group where the bot is an admin, and
 * notifications to the owner's own chat. A message the bot sent can be edited (text or caption, and
 * a photo's photo) and deleted; Telegram refuses to delete one older than 48 hours.
 */
export class Telegram implements Editable<TelegramEdit>, Deletable {
  readonly #token: string;
  readonly #chatId: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;

  constructor(options: { botToken: string; chatId: string | number; fetch?: typeof fetch; baseUrl?: string }) {
    this.#token = options.botToken;
    this.#chatId = String(options.chatId);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#base = options.baseUrl ?? 'https://api.telegram.org';
  }

  async #call<T>(method: string, what: string, params: Record<string, unknown> = {}): Promise<T> {
    const response = await this.#fetch(`${this.#base}/bot${this.#token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    return (await json<Answer<T>>('Telegram', response, what)).result;
  }

  async publish(post: TelegramPost): Promise<Published> {
    const parse = post.parseMode ? { parse_mode: post.parseMode } : {};
    const sent = post.imageUrl
      ? await this.#call<SentMessage>('sendPhoto', 'publish', { chat_id: this.#chatId, photo: post.imageUrl, caption: post.text, ...parse })
      : await this.#call<SentMessage>('sendMessage', 'publish', { chat_id: this.#chatId, text: post.text, ...parse });
    return { externalId: `${this.#chatId}:${sent.message_id}`, url: messageUrl(this.#chatId, sent.chat, sent.message_id) };
  }

  /**
   * The Bot API cannot read a message back, so whether it is text or a photo is learnt by trying:
   * the text first, the caption when Telegram says there is no text. Sending what it already says is
   * not a failure.
   */
  async edit(externalId: string, edit: TelegramEdit): Promise<void> {
    const message = messageOf(externalId);
    const parse = edit.parseMode ? { parse_mode: edit.parseMode } : {};
    try {
      if (edit.imageUrl) {
        await this.#call('editMessageMedia', 'edit', { ...message, media: { type: 'photo', media: edit.imageUrl, caption: edit.text, ...parse } });
        return;
      }
      try {
        await this.#call('editMessageText', 'edit', { ...message, text: edit.text, ...parse });
      } catch (error) {
        if (!said(error, /no text in the message/i)) throw error;
        await this.#call('editMessageCaption', 'edit', { ...message, caption: edit.text, ...parse });
      }
    } catch (error) {
      if (said(error, /message is not modified/i)) return;
      throw error;
    }
  }

  /** A message that is gone already is what was asked for, so that answer is not a failure */
  async delete(externalId: string): Promise<void> {
    try {
      await this.#call('deleteMessage', 'delete', messageOf(externalId));
    } catch (error) {
      if (!said(error, /message to delete not found/i)) throw error;
    }
  }

  /** A message to the owner, without the preview card a link would unfold into. */
  async notify(text: string): Promise<void> {
    await this.#call('sendMessage', 'notify', { chat_id: this.#chatId, text, link_preview_options: { is_disabled: true } });
  }

  /** The Bot API gives bots no per-message views or reactions (only channel admins see them, in the app). */
  async metrics(): Promise<Metrics> {
    return {};
  }

  async check(): Promise<Check> {
    try {
      const me = await this.#call<{ username: string }>('getMe', 'check the bot');
      const chat = await this.#call<{ title?: string; username?: string }>('getChat', 'check the chat', { chat_id: this.#chatId });
      // No picture: the chat's photo is only downloadable at an address with the bot token in it,
      // which must never be stored or reach a browser
      return okCheck(`@${me.username} in ${chat.title ?? chat.username ?? this.#chatId}`, { displayName: chat.title });
    } catch (error) {
      return checkProblem(error, 'the bot token was rejected, or the bot cannot see that chat (add it as an admin)');
    }
  }

  /** A channel's or group's members: the one count the Bot API gives */
  async profileStats(): Promise<ProfileStats> {
    const members = await this.#call<number>('getChatMemberCount', 'count the members', { chat_id: this.#chatId });
    return statsOf({ followers: members });
  }
}
