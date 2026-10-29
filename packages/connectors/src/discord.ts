import { json, checkProblem, ConnectorError, expectOk, okCheck, pictureBytes, PostGone, statsOf, type Check, type Deletable, type Editable, type Metrics, type MetricsMany, type Profile, type ProfileEdit, type ProfileEditor, type ProfileReader, type ProfileStats, type Published } from './http.ts';

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

/** Discord's JSON error code for a webhook that no longer exists; 10008 is a message that does not */
const UNKNOWN_WEBHOOK = 10015;
/** How old a message may be and still have its reactions read */
const MAX_AGE_DAYS = 30;
/** The longest wait a 429 asks for that is waited out within a read */
const MAX_RETRY_AFTER_MS = 60_000;

/** When a message was sent, from its id: a snowflake's top bits are the milliseconds since 2015. Undefined for an id that is not one */
function snowflakeTime(id: string): number | undefined {
  return /^\d{15,20}$/.test(id) ? Number(BigInt(id) >> 22n) + 1_420_070_400_000 : undefined;
}

/** A 429's wait in milliseconds: the body's `retry_after` (seconds, fractional), else the Retry-After header */
function retryAfterMs(body: unknown, headers: Headers): number | undefined {
  const seconds = (body as { retry_after?: unknown } | undefined)?.retry_after ?? Number(headers.get('retry-after') ?? Number.NaN);
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : undefined;
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
  readonly #now: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;
  #info: WebhookInfo | undefined;

  constructor(options: { webhookUrl: string; fetch?: typeof fetch; baseUrl?: string; now?: () => Date; sleep?: (ms: number) => Promise<void> }) {
    // baseUrl swaps the host only, so a test or a proxy can stand in for discord.com
    this.#webhook = options.baseUrl ? options.webhookUrl.replace(/^https:\/\/[^/]+/, options.baseUrl) : options.webhookUrl;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
   * Webhook Message). Discord counts no views. A 404 is one of two things, told by Discord's code:
   * 10008 Unknown Message, a message deleted on Discord, throws PostGone; 10015 Unknown Webhook, the
   * webhook itself deleted, is a problem with the connection, not with the post, and throws as one.
   * A 429 is waited out once (its `retry_after`, up to a minute), then thrown.
   */
  async metrics(externalId: string): Promise<Metrics> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.#fetch(this.#message(externalId));
      if (response.status === 429 && attempt === 0) {
        const wait = retryAfterMs(await response.json().catch(() => undefined), response.headers);
        if (wait !== undefined && wait <= MAX_RETRY_AFTER_MS) {
          await this.#sleep(wait);
          continue;
        }
      }
      if (response.status === 404) {
        const body = (await response.json().catch(() => undefined)) as { code?: number } | undefined;
        if (body?.code === UNKNOWN_WEBHOOK) throw new ConnectorError('Discord', 'the webhook was deleted on Discord: connect Discord again with a new one', 404, false);
        throw new PostGone('Discord', `the message ${externalId} is not in the channel any more`, 404);
      }
      const message = await json<{ reactions?: Array<{ count?: number }> }>('Discord', response, 'metrics');
      return { reactions: (message.reactions ?? []).reduce((n, r) => n + (r.count ?? 0), 0) };
    }
  }

  /**
   * Each message's numbers, one call each (Discord reads one message a call). A deleted message is
   * left out. A message older than MAX_AGE_DAYS is left out unread, keeping its last numbers: its
   * reactions have settled, and a call each for every message ever posted would grow without end. A
   * deleted webhook or a rate limit Discord keeps to ends the read, said in `problems`, with what was
   * read before it kept.
   */
  async metricsMany(externalIds: readonly string[]): Promise<MetricsMany> {
    const out: MetricsMany = new Map();
    const oldest = this.#now().getTime() - MAX_AGE_DAYS * 86_400_000;
    for (const id of externalIds) {
      const sent = snowflakeTime(id);
      if (sent !== undefined && sent < oldest) continue;
      try {
        out.set(id, await this.metrics(id));
      } catch (error) {
        if (error instanceof PostGone) continue;
        if (error instanceof ConnectorError && (error.status === 429 || (error.status === 404 && !error.retryable))) {
          out.problems = [error.message];
          break;
        }
        throw error;
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
