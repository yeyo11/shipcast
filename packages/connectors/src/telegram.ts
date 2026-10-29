import {
  ConnectorError,
  json,
  checkProblem,
  okCheck,
  pictureBytes,
  statsOf,
  type Check,
  type Deletable,
  type Editable,
  type Metrics,
  type Profile,
  type ProfileEdit,
  type ProfileEditor,
  type ProfileReader,
  type ProfileStats,
  type Published,
} from './http.ts';

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

/** An update `getUpdates` answers; only reaction counts are asked for */
interface ReactionUpdate {
  update_id: number;
  message_reaction_count?: { chat: { id: number; username?: string }; message_id: number; date: number; reactions: Array<{ total_count: number }> };
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
export class Telegram implements Editable<TelegramEdit>, Deletable, ProfileReader, ProfileEditor {
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

  /**
   * One post's reactions, when they changed since the last read: see `metricsMany`, which this reads
   * through, so it takes every other post's changes with it.
   */
  async metrics(externalId: string): Promise<Metrics> {
    return (await this.metricsMany([externalId])).get(externalId) ?? {};
  }

  /**
   * The reactions of the posts whose reactions changed since the last read, every emoji's added up.
   * The Bot API has no way to read a message or its counts back: a bot that is an admin of the channel
   * is pushed a `message_reaction_count` update when a post's reactions change (a channel's reactions
   * are anonymous), which it collects with `getUpdates` and Telegram keeps for 24 hours. Reading them
   * confirms them, so each is read once; a post with no change since is left out, and keeps the
   * numbers it had. Views are not there: the Bot API gives bots no views or forwards of a post.
   */
  async metricsMany(externalIds: readonly string[]): Promise<Map<string, Metrics>> {
    const wanted = externalIds.map((id) => ({ id, ...messageOf(id) }));
    const out = new Map<string, Metrics>();
    let offset: number | undefined;
    // A hundred a call; the call after the last confirms what was read, and an empty answer ends it
    for (let page = 0; page < 20; page++) {
      let updates: ReactionUpdate[];
      try {
        updates = await this.#call<ReactionUpdate[]>('getUpdates', 'read the reactions', { ...(offset !== undefined && { offset }), limit: 100, timeout: 0, allowed_updates: ['message_reaction_count'] });
      } catch (error) {
        if (error instanceof ConnectorError && error.status === 409) {
          throw new ConnectorError('Telegram', 'the bot has a webhook set, or another program reads its updates: Shipcast reads reactions with getUpdates, which Telegram then refuses', 409, false);
        }
        throw error;
      }
      if (updates.length === 0) break;
      for (const update of updates) {
        offset = update.update_id + 1;
        const changed = update.message_reaction_count;
        if (!changed) continue;
        const post = wanted.find((w) => w.message_id === changed.message_id && (w.chat_id === String(changed.chat.id) || w.chat_id === `@${changed.chat.username}`));
        // In order, so a later change of the same post replaces an earlier one
        if (post) out.set(post.id, { reactions: changed.reactions.reduce((n, r) => n + r.total_count, 0) });
      }
    }
    return out;
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

  /**
   * The channel's title, description and public link, and whether the bot may change them: Telegram
   * needs the "Change channel info" admin right for that, which the bot's own membership says.
   */
  async profile(): Promise<Profile> {
    const chat = await this.#call<{ title?: string; description?: string; username?: string; photo?: unknown }>('getChat', 'read the chat', { chat_id: this.#chatId });
    const me = await this.#call<{ id: number }>('getMe', 'read the bot');
    const member = await this.#call<{ status: string; can_change_info?: boolean }>('getChatMember', 'read the bot’s rights', { chat_id: this.#chatId, user_id: me.id });
    const allowed = member.status === 'creator' || member.can_change_info === true;
    return {
      ...(chat.title?.trim() && { displayName: chat.title }),
      ...(chat.description?.trim() && { bio: chat.description }),
      links: chat.username ? [{ name: 'Link', value: `https://t.me/${chat.username}` }] : [],
      hasAvatar: chat.photo !== undefined,
      editable: allowed ? { ok: true } : { ok: false, why: 'the bot is not allowed to change the channel’s info: give it the “Change channel info” admin right' },
    };
  }

  /** The title and the description; sending what they already say is not a failure */
  async editProfile(edit: ProfileEdit): Promise<void> {
    if (edit.links !== undefined) throw new ConnectorError('Telegram', 'a channel’s link is its username, which a bot cannot change', 400, false);
    const run = async (method: string, params: Record<string, unknown>) => {
      try {
        await this.#call(method, 'edit the channel', { chat_id: this.#chatId, ...params });
      } catch (error) {
        if (said(error, /not modified/i)) return;
        if (said(error, /not enough rights|CHAT_ADMIN_REQUIRED/i)) {
          throw new ConnectorError('Telegram', 'the bot is not allowed to change the channel’s info: give it the “Change channel info” admin right', 400, false);
        }
        throw error;
      }
    };
    if (edit.displayName !== undefined) {
      if (!edit.displayName.trim()) throw new ConnectorError('Telegram', 'a channel’s title cannot be empty', 400, false);
      await run('setChatTitle', { title: edit.displayName });
    }
    if (edit.bio !== undefined) await run('setChatDescription', { description: edit.bio });
    if (edit.picture !== undefined) await this.#setPhoto(edit.picture);
  }

  /** The channel's photo, uploaded (setChatPhoto takes a file, never an address); the same admin right as the title */
  async #setPhoto(url: string): Promise<void> {
    const { bytes, type } = await pictureBytes('Telegram', url, this.#fetch);
    const form = new FormData();
    form.set('chat_id', this.#chatId);
    form.set('photo', new Blob([bytes], { type }), `photo.${type.split('/')[1]}`);
    const response = await this.#fetch(`${this.#base}/bot${this.#token}/setChatPhoto`, { method: 'POST', body: form });
    try {
      await json<Answer<true>>('Telegram', response, 'set the channel’s photo');
    } catch (error) {
      if (said(error, /not enough rights|CHAT_ADMIN_REQUIRED/i)) {
        throw new ConnectorError('Telegram', 'the bot is not allowed to change the channel’s info: give it the “Change channel info” admin right', 400, false);
      }
      throw error;
    }
  }

  /** A channel's or group's members: the one count the Bot API gives */
  async profileStats(): Promise<ProfileStats> {
    const members = await this.#call<number>('getChatMemberCount', 'count the members', { chat_id: this.#chatId });
    return statsOf({ followers: members });
  }
}
