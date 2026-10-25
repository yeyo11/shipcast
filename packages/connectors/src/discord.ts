import { json, checkProblem, okCheck, type Check, type Metrics, type Published } from './http.ts';

export interface DiscordPost {
  /** 2000 characters at most */
  content: string;
  embed?: { title: string; url: string; description: string; imageUrl?: string };
}

interface WebhookInfo {
  id?: string;
  name: string;
  avatar?: string | null;
  guild_id?: string;
  channel_id: string | null;
}

/** Discord through a channel webhook: posts a message, with an optional link card. */
export class Discord {
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
      body: JSON.stringify({
        content: post.content,
        ...(embed
          ? { embeds: [{ title: embed.title, url: embed.url, description: embed.description, ...(embed.imageUrl ? { image: { url: embed.imageUrl } } : {}) }] }
          : {}),
      }),
    });
    const message = await json<{ id: string; channel_id: string }>('Discord', response, 'publish');
    const info = await this.#webhookInfo();
    return { externalId: message.id, url: `https://discord.com/channels/${info.guild_id ?? '@me'}/${message.channel_id}/${message.id}` };
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
