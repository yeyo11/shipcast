import { json, checkProblem, ConnectorError, expectOk, okCheck, pictureBytes, PostGone, statsOf, type Check, type Deletable, type Editable, type Metrics, type Profile, type ProfileEdit, type ProfileEditor, type ProfileReader, type ProfileStats, type Published } from './http.ts';

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
export class Discord implements Editable<DiscordEdit>, Deletable, ProfileReader, ProfileEditor {
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

  /**
   * A message's reactions, every emoji's added up, read back with the webhook that sent it (Get
   * Webhook Message). Discord counts no views. A message deleted on Discord throws PostGone.
   */
  async metrics(externalId: string): Promise<Metrics> {
    const response = await this.#fetch(this.#message(externalId));
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      throw new PostGone('Discord', `the message ${externalId} is not in the channel any more`, 404);
    }
    const message = await json<{ reactions?: Array<{ count?: number }> }>('Discord', response, 'metrics');
    return { reactions: (message.reactions ?? []).reduce((n, r) => n + (r.count ?? 0), 0) };
  }

  /** Each message's numbers, one call each (Discord reads one message a call); a deleted one is left out */
  async metricsMany(externalIds: readonly string[]): Promise<Map<string, Metrics>> {
    const out = new Map<string, Metrics>();
    for (const id of externalIds) {
      try {
        out.set(id, await this.metrics(id));
      } catch (error) {
        if (!(error instanceof PostGone)) throw error;
      }
    }
    return out;
  }

  /**
   * The server's members, through one of its invites (`approximate_member_count`, and how many are
   * online): a webhook does not see its server, and an invite is public, so it needs no bot.
   */
  async profileStats(inviteCode: string): Promise<ProfileStats> {
    const code = inviteCode.trim().replace(/^https?:\/\/(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\//, '').replace(/[/?#].*$/, '');
    const url = `${new URL(this.#webhook).origin}/api/v10/invites/${encodeURIComponent(code)}?with_counts=true`;
    const invite = await json<{ approximate_member_count?: number; approximate_presence_count?: number }>('Discord', await this.#fetch(url), 'read the invite');
    return statsOf({ followers: invite.approximate_member_count }, { online: invite.approximate_presence_count });
  }

  /**
   * The webhook's own name and picture, which every message it posts shows as its author: the one
   * profile a webhook has. The server's own needs a bot with Manage Server.
   */
  async profile(): Promise<Profile> {
    const info = await this.#webhookInfo();
    return { displayName: info.name, links: [], hasAvatar: Boolean(info.avatar), editable: { ok: true } };
  }

  /** The webhook's name and picture, with the URL it already is (Modify Webhook with Token) */
  async editProfile(edit: ProfileEdit): Promise<void> {
    if (edit.bio !== undefined || edit.links !== undefined) throw new ConnectorError('Discord', 'a webhook has a name and a picture only', 400, false);
    const body: { name?: string; avatar?: string } = {};
    if (edit.displayName !== undefined) {
      if (!edit.displayName.trim()) throw new ConnectorError('Discord', 'a webhook’s name cannot be empty', 400, false);
      body.name = edit.displayName;
    }
    if (edit.picture !== undefined) {
      const { bytes, type } = await pictureBytes('Discord', edit.picture, this.#fetch);
      body.avatar = `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
    }
    if (Object.keys(body).length === 0) return;
    // The webhook itself, without a thread the URL may name for its messages
    const webhook = new URL(this.#webhook);
    webhook.search = '';
    const response = await this.#fetch(String(webhook), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    this.#info = await json<WebhookInfo>('Discord', response, 'edit the webhook');
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
