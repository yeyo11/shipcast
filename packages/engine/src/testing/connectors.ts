import type { Comment, Metrics, Published, ReplyTarget, SentReply } from '@shipcast/connectors';
import type { Channel } from '@shipcast/schema';
import { REPLY_CAPABILITIES, type CommentConnectors, type CommentDeps } from '../comments.ts';
import type { EditDeps, Editors } from '../edit.ts';
import type { MetricSources } from '../metrics.ts';
import { PUBLISHED_BY_ENGINE, type Publishers } from '../publish.ts';

/*
 * Every connector capability the engine takes, faked once: publishers, editors and deleters, metric
 * readers, comment readers and repliers. Each call is recorded in one log, in order, with the
 * account it was built for where the engine passes one; a failure is set per channel and action,
 * for every call or for the next few. What a fake answers is predictable: the n-th piece published
 * on a channel is `<channel>-<n>` at `https://<channel>.example/<n>`.
 */

export type ConnectorAction = 'publish' | 'publishStory' | 'comment' | 'find' | 'subscribers' | 'send' | 'edit' | 'delete' | 'metrics' | 'comments' | 'reply';

export interface ConnectorCall {
  channel: Channel;
  action: ConnectorAction;
  /** The network's id the call is about: the post edited, deleted, read or replied under */
  id?: string;
  input?: unknown;
  /** The account the connector was built for (null: `.env`); only for what the engine builds per account */
  accountId?: number | null;
}

export type PublishingChannel = (typeof PUBLISHED_BY_ENGINE)[number];

/** The channels whose published pieces can be edited or deleted from Shipcast */
type EditorChannel = keyof Editors;
const EDITS: readonly EditorChannel[] = ['mastodon', 'telegram', 'discord', 'devto', 'hashnode', 'githubDiscussions'];
const DELETES_ONLY: readonly EditorChannel[] = ['bluesky', 'threads', 'linkedin', 'reddit'];

interface Failure {
  error: Error;
  /** Calls left to fail; undefined fails every one */
  left: number | undefined;
}

export class FakeConnectors {
  readonly calls: ConnectorCall[];
  /** Per channel, what a metric reader answers: fixed numbers, or numbers per post */
  metrics: Partial<Record<Channel, Metrics | ((externalId: string) => Metrics)>> = {};
  /** Per channel and post id (`mastodon:100`), the comments under it */
  threads: Record<string, Comment[]> = {};
  /** Per newsletter list, how many are on it; one when not set */
  subscribers: Record<number, number> = {};
  /** Per subreddit and title, a post Reddit already has (the answer of a submit that was lost) */
  redditFound: Record<string, Published> = {};
  /** Channels whose connectors cannot be built: no account, no credentials */
  readonly unconnected = new Set<Channel>();
  readonly #failures = new Map<string, Failure>();
  readonly #counts = new Map<string, number>();

  /** `calls` may be a log the test already holds, shared with other fakes */
  constructor(calls: ConnectorCall[] = []) {
    this.calls = calls;
  }

  /** `channel`'s `action` throws `error`: on every call, or on the next `times` calls only */
  fail(channel: Channel, action: ConnectorAction, error: Error, times?: number): this {
    this.#failures.set(`${channel} ${action}`, { error, left: times });
    return this;
  }

  /** Clears a failure set with `fail` */
  heal(channel: Channel, action: ConnectorAction): this {
    this.#failures.delete(`${channel} ${action}`);
    return this;
  }

  /** The calls of a channel, or of one action on it */
  callsOf(channel: Channel, action?: ConnectorAction): ConnectorCall[] {
    return this.calls.filter((c) => c.channel === channel && (action === undefined || c.action === action));
  }

  /** `channel action` for each call, in order: the shortest way to assert what reached the networks */
  get log(): string[] {
    return this.calls.map((c) => `${c.channel} ${c.action}${c.id === undefined ? '' : ` ${c.id}`}`);
  }

  #call(call: ConnectorCall): void {
    this.calls.push(call);
    const key = `${call.channel} ${call.action}`;
    const failure = this.#failures.get(key);
    if (!failure) return;
    if (failure.left !== undefined && --failure.left <= 0) this.#failures.delete(key);
    throw failure.error;
  }

  #nth(key: string): number {
    const n = (this.#counts.get(key) ?? 0) + 1;
    this.#counts.set(key, n);
    return n;
  }

  #published(channel: Channel): Published {
    const n = this.#nth(channel);
    return { externalId: `${channel}-${n}`, url: `https://${channel}.example/${n}` };
  }

  /** Publishers for the channels named, every one the engine publishes to when none are */
  publishers(channels: readonly PublishingChannel[] = PUBLISHED_BY_ENGINE): Publishers {
    const publish = (channel: Channel) => async (input: unknown) => {
      this.#call({ channel, action: 'publish', input });
      return this.#published(channel);
    };
    const all: Required<Publishers> = {
      devto: { publish: publish('devto') },
      hashnode: { publish: publish('hashnode') },
      bluesky: { publish: publish('bluesky') },
      mastodon: { publish: publish('mastodon') },
      telegram: { publish: publish('telegram') },
      discord: { publish: publish('discord') },
      githubDiscussions: { publish: publish('githubDiscussions') },
      threads: { publish: publish('threads') },
      linkedin: { publish: publish('linkedin') },
      instagram: {
        publish: publish('instagram'),
        publishStory: async (input) => {
          this.#call({ channel: 'instagram', action: 'publishStory', input });
          const n = this.#nth('instagram story');
          return { externalId: `instagram-story-${n}`, url: `https://instagram.example/story/${n}` };
        },
        comment: async (mediaId, message) => {
          this.#call({ channel: 'instagram', action: 'comment', id: mediaId, input: message });
          return { id: `instagram-comment-${this.#nth('instagram comment')}` };
        },
      },
      newsletter: {
        subscribers: async (listId) => {
          this.#call({ channel: 'newsletter', action: 'subscribers', input: listId });
          return this.subscribers[listId] ?? 1;
        },
        send: async (campaign) => {
          this.#call({ channel: 'newsletter', action: 'send', input: campaign });
          return this.#published('newsletter');
        },
      },
      reddit: {
        publish: publish('reddit'),
        find: async (p, since) => {
          this.#call({ channel: 'reddit', action: 'find', input: { ...p, since: since.toISOString() } });
          return this.redditFound[`${p.subreddit}:${p.title}`];
        },
      },
    };
    return Object.fromEntries(channels.map((c) => [c, all[c]])) as Publishers;
  }

  /** The editors the engine builds per channel and account: one channel's at a time, none for an unconnected one */
  editors(): EditDeps['editors'] {
    return async (channel, accountId) => {
      if (this.unconnected.has(channel)) return {};
      const remove = async (id: string) => this.#call({ channel, action: 'delete', id, accountId });
      const edit = async (id: string, input: unknown) => this.#call({ channel, action: 'edit', id, input, accountId });
      const name = channel as EditorChannel;
      if (EDITS.includes(name)) return { [name]: { edit, delete: remove } } as Editors;
      if (DELETES_ONLY.includes(name)) return { [name]: { delete: remove } } as Editors;
      return {};
    };
  }

  /** A metric reader per channel named; each answers what `metrics` holds for it, or nothing */
  metricReaders(channels: readonly Channel[]): NonNullable<MetricSources['posts']> {
    return Object.fromEntries(
      channels.map((channel) => [
        channel,
        {
          metrics: async (externalId: string): Promise<Metrics> => {
            this.#call({ channel, action: 'metrics', id: externalId });
            const answer = this.metrics[channel];
            return typeof answer === 'function' ? answer(externalId) : { ...answer };
          },
        },
      ]),
    );
  }

  /** Comment readers for every channel, and repliers where the network can reply */
  commentConnectors(): CommentDeps['connectors'] {
    return async (channel, accountId): Promise<CommentConnectors> => {
      if (this.unconnected.has(channel)) return {};
      const capability = REPLY_CAPABILITIES[channel];
      return {
        reader: {
          comments: async (postExternalId) => {
            this.#call({ channel, action: 'comments', id: postExternalId, accountId });
            return [...(this.threads[`${channel}:${postExternalId}`] ?? [])];
          },
        },
        ...(capability?.reply && {
          replier: {
            reply: async (target: ReplyTarget, text: string, options?: { key?: string; lang?: string }): Promise<SentReply> => {
              this.#call({ channel, action: 'reply', id: target.commentExternalId, input: { target, text, ...(options?.key && { key: options.key }) }, accountId });
              const n = this.#nth(`${channel} reply`);
              return { externalId: `${channel}-reply-${n}`, url: `https://${channel}.example/reply/${n}` };
            },
          },
        }),
      };
    };
  }
}
