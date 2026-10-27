import {
  checkProblem,
  ConnectorError,
  expectOk,
  htmlToText,
  imageUrl,
  json,
  okCheck,
  PostGone,
  statsOf,
  type Check,
  type Comment,
  type CommentReader,
  type Deletable,
  type Editable,
  type Metrics,
  type Profile,
  type ProfileEdit,
  type ProfileEditor,
  type ProfileReader,
  type ProfileStats,
  type Published,
  type Replier,
  type ReplyTarget,
  type SentReply,
} from './http.ts';

interface MastodonAccount {
  id: string;
  acct: string;
  display_name?: string;
  avatar?: string;
  followers_count?: number;
  following_count?: number;
  statuses_count?: number;
  avatar_static?: string;
  header?: string;
  note?: string;
  fields?: Array<{ name: string; value: string }>;
  /** The owner's own account only: the note and fields as plain text, as they were written */
  source?: { note?: string; fields?: Array<{ name: string; value: string }> };
}

/** Mastodon gives an account with no picture or banner a placeholder image, named `missing` */
const placeholder = (url: string | undefined) => !url || /\/missing\.png(\?|$)/.test(url);

/** The scope `update_credentials` needs, which tokens from before 2026-10-27 were not granted */
export const MASTODON_PROFILE_SCOPE = 'write:accounts';

interface MastodonStatus {
  id: string;
  in_reply_to_id: string | null;
  account: MastodonAccount;
  content: string;
  created_at: string;
  url?: string | null;
  visibility: 'public' | 'unlisted' | 'private' | 'direct';
}

/** The author's name and picture, each only when there is one */
function profileOf(account: MastodonAccount): { displayName?: string; avatarUrl?: string } {
  const avatarUrl = imageUrl(account.avatar);
  const displayName = account.display_name?.trim();
  return { ...(displayName && { displayName }), ...(avatarUrl && { avatarUrl }) };
}

export interface MastodonPost {
  text: string;
  lang: string;
  /** An image attached to the post */
  image?: { bytes: Uint8Array; mimeType: string; filename: string; description: string };
  /** Mastodon refuses a second status with the same key, so a retried publish never posts twice */
  idempotencyKey: string;
}

export interface MastodonEdit {
  /** The status's new text; left out, the text it has is kept */
  text?: string;
  /** A new image in place of the one it has; left out, its media stay */
  image?: MastodonPost['image'];
}

/**
 * Mastodon through its REST API: a public status (with an optional image, described for screen
 * readers), and its favourites, boosts and replies read back from the status. A status can be edited
 * (text and media) and deleted, and the replies under it read and answered.
 */
export class Mastodon implements Editable<MastodonEdit>, Deletable, CommentReader, Replier, ProfileReader, ProfileEditor {
  readonly #instance: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  #ownAccount: Promise<string> | undefined;

  constructor(options: { instance: string; accessToken: string; fetch?: typeof fetch }) {
    this.#instance = options.instance.replace(/\/+$/, '');
    this.#token = options.accessToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async #upload(image: NonNullable<MastodonPost['image']>): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([image.bytes as Uint8Array<ArrayBuffer>], { type: image.mimeType }), image.filename);
    form.append('description', image.description);
    const uploaded = await this.#fetch(`${this.#instance}/api/v2/media`, { method: 'POST', headers: { authorization: `Bearer ${this.#token}` }, body: form });
    return (await json<{ id: string }>('Mastodon', uploaded, 'upload the image')).id;
  }

  async publish(post: MastodonPost): Promise<Published> {
    const auth = { authorization: `Bearer ${this.#token}` };
    const mediaIds: string[] = [];
    if (post.image) mediaIds.push(await this.#upload(post.image));
    const response = await this.#fetch(`${this.#instance}/api/v1/statuses`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': post.idempotencyKey },
      body: JSON.stringify({ status: post.text, language: post.lang, visibility: 'public', media_ids: mediaIds }),
    });
    const created = await json<{ id: string; url: string }>('Mastodon', response, 'publish');
    return { externalId: created.id, url: created.url };
  }

  /**
   * PUT replaces the status as a whole, so what is not changing is read first and sent back: its
   * media ids and language, and its plain source text when only the image changes (the status itself
   * carries the text as rendered HTML).
   */
  async edit(externalId: string, edit: MastodonEdit): Promise<void> {
    const auth = { authorization: `Bearer ${this.#token}` };
    const id = encodeURIComponent(externalId);
    const current = await json<{ language?: string | null; media_attachments?: Array<{ id: string }> }>(
      'Mastodon',
      await this.#fetch(`${this.#instance}/api/v1/statuses/${id}`, { headers: auth }),
      'read the status',
    );
    const text =
      edit.text ??
      (await json<{ text: string }>('Mastodon', await this.#fetch(`${this.#instance}/api/v1/statuses/${id}/source`, { headers: auth }), 'read the status text')).text;
    const mediaIds = edit.image ? [await this.#upload(edit.image)] : (current.media_attachments ?? []).map((m) => m.id);
    const response = await this.#fetch(`${this.#instance}/api/v1/statuses/${id}`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ status: text, media_ids: mediaIds, ...(current.language ? { language: current.language } : {}) }),
    });
    await expectOk('Mastodon', response, 'edit');
  }

  async delete(externalId: string): Promise<void> {
    const response = await this.#fetch(`${this.#instance}/api/v1/statuses/${encodeURIComponent(externalId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.#token}` },
    });
    await expectOk('Mastodon', response, 'delete');
  }

  async #me(what: string): Promise<MastodonAccount> {
    const response = await this.#fetch(`${this.#instance}/api/v1/accounts/verify_credentials`, { headers: { authorization: `Bearer ${this.#token}` } });
    return json<MastodonAccount>('Mastodon', response, what);
  }

  /** The token's account; also proves the token may read, which the metrics need */
  async check(): Promise<Check> {
    try {
      const me = await this.#me('check');
      return okCheck(`@${me.acct}@${new URL(this.#instance).host}`, { avatarUrl: me.avatar, displayName: me.display_name });
    } catch (error) {
      return checkProblem(error);
    }
  }

  async profileStats(): Promise<ProfileStats> {
    const me = await this.#me('read the profile');
    return statsOf({ followers: me.followers_count, following: me.following_count, posts: me.statuses_count });
  }

  /** The profile as the owner wrote it: the plain source of the note and the fields, not their HTML */
  async profile(): Promise<Profile> {
    const me = await this.#me('read the profile');
    // The source is plain text; the account's own fields are HTML (a link becomes an anchor)
    const fields = me.source?.fields ?? (me.fields ?? []).map((f) => ({ name: f.name, value: htmlToText(f.value) }));
    const bio = me.source?.note ?? (me.note ? htmlToText(me.note) : '');
    return {
      ...(me.display_name?.trim() && { displayName: me.display_name }),
      ...(bio.trim() && { bio }),
      links: fields.map((f) => ({ name: f.name, value: f.value })),
      hasAvatar: !placeholder(me.avatar),
      hasBanner: !placeholder(me.header),
    };
  }

  /**
   * `update_credentials` with what changes: the name, the note, and the fields as a whole list (the
   * ones left out are removed). It needs `write:accounts`, which a token from an older connection
   * lacks: Mastodon answers 403, said as what to do.
   */
  async editProfile(edit: ProfileEdit): Promise<void> {
    const form = new URLSearchParams();
    if (edit.displayName !== undefined) form.set('display_name', edit.displayName);
    if (edit.bio !== undefined) form.set('note', edit.bio);
    if (edit.links) {
      // An empty list still has to say so, or Mastodon keeps the fields it has
      const links = edit.links.length > 0 ? edit.links : [{ name: '', value: '' }];
      links.forEach((link, i) => {
        form.set(`fields_attributes[${i}][name]`, link.name);
        form.set(`fields_attributes[${i}][value]`, link.value);
      });
    }
    const response = await this.#fetch(`${this.#instance}/api/v1/accounts/update_credentials`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (response.status === 403) {
      throw new ConnectorError('Mastodon', `the token was not granted ${MASTODON_PROFILE_SCOPE}: connect the account again to allow profile edits`, 403, false);
    }
    await expectOk('Mastodon', response, 'edit the profile');
  }

  /** The token's own account id, read once: what tells the owner's replies from the others' */
  async #ownId(): Promise<string> {
    this.#ownAccount ??= this.#me('read the account').then(
      (me) => me.id,
      (error: unknown) => {
        this.#ownAccount = undefined;
        throw error;
      },
    );
    return this.#ownAccount;
  }

  /**
   * The replies under a status, from its context's descendants, threads included. Only public and
   * unlisted ones: a private or direct reply was meant for the owner alone, and nothing Shipcast
   * drafts or shows should treat it as a public comment.
   */
  async comments(externalId: string): Promise<Comment[]> {
    const id = encodeURIComponent(externalId);
    const context = await json<{ descendants: MastodonStatus[] }>(
      'Mastodon',
      await this.#fetch(`${this.#instance}/api/v1/statuses/${id}/context`, { headers: { authorization: `Bearer ${this.#token}` } }),
      'read the replies',
    ).catch((error: unknown) => {
      // A deleted status is Mastodon's own 404, not any 404: a wrong instance address must not delete every post
      if (error instanceof ConnectorError && error.status === 404 && error.message.includes('"error":"Record not found"')) throw new PostGone('Mastodon', `the status ${externalId} no longer exists`, 404);
      throw error;
    });
    const own = await this.#ownId();
    const host = new URL(this.#instance).host;
    return context.descendants
      .filter((s) => s.visibility === 'public' || s.visibility === 'unlisted')
      .map((s) => ({
        externalId: s.id,
        // A local account's acct has no instance; the full handle is what a person can look up anywhere
        author: { handle: `@${s.account.acct.includes('@') ? s.account.acct : `${s.account.acct}@${host}`}`, ...profileOf(s.account) },
        text: htmlToText(s.content),
        createdAt: s.created_at,
        ...(s.in_reply_to_id && s.in_reply_to_id !== externalId && { inReplyTo: s.in_reply_to_id }),
        ...(s.url && { url: s.url }),
        own: s.account.id === own,
      }));
  }

  /**
   * A public reply. Mastodon notifies only the accounts the text mentions, so it starts with the
   * author's handle unless the draft names them already; the key makes a retried send a no-op.
   */
  async reply(target: ReplyTarget, text: string, options: { key?: string; lang?: string } = {}): Promise<SentReply> {
    const mention = target.authorHandle.startsWith('@') ? target.authorHandle : `@${target.authorHandle}`;
    const status = text.includes(mention) ? text : `${mention} ${text}`;
    const response = await this.#fetch(`${this.#instance}/api/v1/statuses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#token}`,
        'content-type': 'application/json',
        ...(options.key && { 'idempotency-key': options.key }),
      },
      body: JSON.stringify({ status, in_reply_to_id: target.commentExternalId, visibility: 'public', ...(options.lang && { language: options.lang }) }),
    });
    const created = await json<{ id: string; url: string }>('Mastodon', response, 'reply');
    return { externalId: created.id, url: created.url };
  }

  async metrics(externalId: string): Promise<Metrics> {
    const response = await this.#fetch(`${this.#instance}/api/v1/statuses/${externalId}`, {
      headers: { authorization: `Bearer ${this.#token}` },
    });
    const status = await json<{ favourites_count: number; reblogs_count: number; replies_count: number }>('Mastodon', response, 'metrics');
    return { favourites: status.favourites_count, boosts: status.reblogs_count, replies: status.replies_count };
  }
}
