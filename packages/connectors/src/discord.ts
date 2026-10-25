import { json, checkProblem, expectOk, okCheck, type Check, type Deletable, type Editable, type Metrics, type Published } from './http.ts';

export interface DiscordPost {
  /** 2000 characters at most */
  content: string;
  embed?: { title: string; url: string; description: string; imageUrl?: string };
}

/** What an edit sends: the content, and the link card in place of the one it has when given */
export type DiscordEdit = DiscordPost;

function embedOf(embed: DiscordPost['embed']) {
  return embed
    ? { embeds: [{ title: embed.title, url: embed.url, description: embed.description, ...(embed.imageUrl ? { image: { url: embed.imageUrl } } : {}) }] }
    : {};
}

interface WebhookInfo {
  id?: string;
  name: string;
  avatar?: string | null;
  guild_id?: string;
  channel_id: string | null;
}

/**
 * Discord through a channel webhook: posts a message, with an optional link card. The webhook's URL
 * holds its id and token, which is all Discord asks to edit or delete a message the webhook sent.
 */
export class Discord implements Editable<DiscordEdit>, Deletable {
  readonly #webhook: string;
  readonly #fetch: typeof fetch;
  #info: WebhookInfo | undefined;

  constructor(options: { webhookUrl: string; fetch?: typeof fetch; baseUrl?: string }) {
    // baseUrl swaps the host only, so a test or a proxy can stand in for discord.com
    this.#webhook = options.baseUrl ? options.webhookUrl.replace(/^https:\/\/[^/]+/, options.baseUrl) : options.webhookUrl;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** The message answer has the channel but not the guild, which the message link needs. */
  async #webhookInfo(): Promise<WebhookInfo> {
    this.#info ??= await json<WebhookInfo>('Discord', await this.#fetch(this.#webhook), 'read the webhook');
    return this.#info;
  }

  async publish(post: DiscordPost): Promise<Published> {
    const { embed } = post;
    const response = await this.#fetch(`${this.#webhook}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: post.content, ...embedOf(embed) }),
    });
    const message = await json<{ id: string; channel_id: string }>('Discord', response, 'publish');
    const info = await this.#webhookInfo();
    return { externalId: message.id, url: `https://discord.com/channels/${info.guild_id ?? '@me'}/${message.channel_id}/${message.id}` };
  }

  /** `/webhooks/{id}/{token}/messages/{message}`, keeping a query the webhook URL had (a thread's id) */
  #message(externalId: string): string {
    const url = new URL(this.#webhook);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/messages/${encodeURIComponent(externalId)}`;
    return String(url);
  }

  /** PATCH changes only what it is sent: without a card, the message keeps the one it has */
  async edit(externalId: string, edit: DiscordEdit): Promise<void> {
    const response = await this.#fetch(this.#message(externalId), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: edit.content, ...embedOf(edit.embed) }),
    });
    await expectOk('Discord', response, 'edit');
  }

  async delete(externalId: string): Promise<void> {
    await expectOk('Discord', await this.#fetch(this.#message(externalId), { method: 'DELETE' }), 'delete');
  }

  /** A webhook cannot read a message back, so there are no reactions or views to report. */
  async metrics(): Promise<Metrics> {
    return {};
  }

  async check(): Promise<Check> {
    try {
      const info = await this.#webhookInfo();
      // The webhook's own picture, on Discord's public CDN; a webhook without one posts with the default
      const avatarUrl = info.avatar && info.id ? `https://cdn.discordapp.com/avatars/${info.id}/${info.avatar}.png?size=128` : undefined;
      return okCheck(info.name, { avatarUrl });
    } catch (error) {
      return checkProblem(error, 'the webhook was rejected, it may have been deleted');
    }
  }
}
