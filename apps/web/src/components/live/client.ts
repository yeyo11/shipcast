/*
 * The tab's side of phase 9's live UI (docs/plans/performance-refactor.md, "6. A live UI"; the
 * server's protocol is in runtime's realtime/stream.ts). One EventSource per tab, whatever the page:
 * each part of the page that shows something registers an interest (the topics it shows and what to
 * reload), the stream carries the union of them, and an event reloads only the interests it
 * concerns, debounced, so a burst of a job's log lines is one read. Nothing here runs on a timer
 * while the stream is up; when it has been down for a while, one slow poll stands in for it.
 *
 * No React and no browser globals in this file: the EventSource and the clock are given, so the
 * tests drive it with fakes (apps/web/test/live-client.test.ts).
 */

/** The kinds the server sends (LIVE_KINDS in runtime's realtime/stream.ts), plus `resync` */
export type LiveKind = 'launch' | 'post' | 'job' | 'comment' | 'metrics' | 'account' | 'attention' | 'settings';

/** What an event says: ids, and for a job its queue and state */
export interface LivePayload {
  launchId?: number | null;
  postId?: number | null;
  commentId?: number;
  accountId?: number;
  id?: string;
  queue?: string;
  state?: string;
  key?: string;
}

export interface LiveEvent {
  kind: LiveKind;
  data: LivePayload;
}

/** `launch` for every launch's events, `job:12` for launch 12's only */
export type Topic = LiveKind | `${LiveKind}:${number}`;

export interface Interest {
  topics: readonly Topic[];
  /** Called once per burst of events it wants, and on a resync */
  reload(): void;
  /** Narrower than the topics, when the topics cannot say it (a job's id); every topic's event by default */
  accepts?(event: LiveEvent): boolean;
  /** Called at once for each event it wants, before the debounced reload: a component following one job */
  onEvent?(event: LiveEvent): void;
  debounceMs?: number;
}

/** The parts of EventSource this uses */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: never) => void) | null;
  onerror: ((event: never) => void) | null;
  addEventListener(type: string, listener: (event: { data: string; lastEventId: string }) => void): void;
  close(): void;
}

export type LiveStatus = 'connecting' | 'live' | 'down';

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface LiveClientOptions {
  connect(url: string): EventSourceLike;
  clock?: Clock;
  /** The stream's address; topics and the last id are added */
  path?: string;
  /** Random jitter in [0, 1) */
  random?: () => number;
}

const KINDS: readonly LiveKind[] = ['launch', 'post', 'job', 'comment', 'metrics', 'account', 'attention', 'settings'];

export const DEBOUNCE_MS = 400;
/** The first reconnect waits this, doubling to BACKOFF_MAX_MS */
export const BACKOFF_MS = 1000;
export const BACKOFF_MAX_MS = 60_000;
/** Down this long, the page says so and polls */
export const DOWN_AFTER_MS = 30_000;
/** The poll that stands in for a stream that is down: slow on purpose */
export const FALLBACK_POLL_MS = 60_000;
/** A change of topics (a navigation) waits this, so a page's interests arriving one by one make one stream */
const RETOPIC_MS = 50;

const realClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

/** Whether `topic` covers `event`: the kind whole, or the kind on the event's launch */
export function topicCovers(topic: Topic, event: LiveEvent): boolean {
  const [kind, launch] = topic.split(':');
  if (kind !== event.kind) return false;
  return launch === undefined || (event.data.launchId != null && Number(launch) === event.data.launchId);
}

export function interestWants(interest: Pick<Interest, 'topics' | 'accepts'>, event: LiveEvent): boolean {
  return interest.topics.some((t) => topicCovers(t, event)) && (interest.accepts?.(event) ?? true);
}

/** The union of the interests' topics, a kind whole dropping its narrowed ones, in a stable order */
export function topicsOf(interests: Iterable<Pick<Interest, 'topics'>>): Topic[] {
  const whole = new Set<string>();
  const narrow = new Set<string>();
  for (const i of interests) for (const t of i.topics) (t.includes(':') ? narrow : whole).add(t);
  const kept = [...narrow].filter((t) => !whole.has(t.split(':')[0] ?? ''));
  return [...[...whole].sort(), ...kept.sort()] as Topic[];
}

interface Entry {
  interest: Interest;
  timer: unknown;
}

export class LiveClient {
  readonly #connect: LiveClientOptions['connect'];
  readonly #clock: Clock;
  readonly #path: string;
  readonly #random: () => number;
  readonly #entries = new Set<Entry>();
  readonly #listeners = new Set<(status: LiveStatus) => void>();
  #source: EventSourceLike | undefined;
  #topicsKey: string | undefined;
  #lastId = '';
  #status: LiveStatus = 'connecting';
  #attempt = 0;
  #retry: unknown;
  #retopic: unknown;
  #downTimer: unknown;
  #poll: unknown;
  #stopped = false;
  /** For the tests and the idle-tab check: streams opened, and reloads asked */
  readonly counts = { connects: 0, reloads: 0 };

  constructor(options: LiveClientOptions) {
    this.#connect = options.connect;
    this.#clock = options.clock ?? realClock;
    this.#path = options.path ?? '/api/events';
    this.#random = options.random ?? Math.random;
  }

  get status(): LiveStatus {
    return this.#status;
  }

  onStatus(listener: (status: LiveStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  /** Registers what a part of the page shows; the stream follows the new union of topics */
  register(interest: Interest): () => void {
    const entry: Entry = { interest, timer: undefined };
    this.#entries.add(entry);
    this.#scheduleRetopic();
    return () => {
      if (entry.timer !== undefined) this.#clock.clearTimeout(entry.timer);
      this.#entries.delete(entry);
      this.#scheduleRetopic();
    };
  }

  stop(): void {
    this.#stopped = true;
    this.#close();
    for (const h of [this.#retry, this.#retopic, this.#downTimer]) if (h !== undefined) this.#clock.clearTimeout(h);
    if (this.#poll !== undefined) this.#clock.clearInterval(this.#poll);
    for (const e of this.#entries) if (e.timer !== undefined) this.#clock.clearTimeout(e.timer);
  }

  #setStatus(status: LiveStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    for (const l of this.#listeners) l(status);
  }

  #scheduleRetopic(): void {
    if (this.#stopped || this.#retopic !== undefined) return;
    this.#retopic = this.#clock.setTimeout(() => {
      this.#retopic = undefined;
      const key = topicsOf([...this.#entries].map((e) => e.interest)).join(',');
      if (this.#entries.size === 0) {
        this.#close();
        this.#topicsKey = undefined;
        return;
      }
      // The same topics: the open stream (or the pending reconnect) already carries them
      if (key === this.#topicsKey) return;
      this.#topicsKey = key;
      if (this.#retry !== undefined) return;
      this.#open();
    }, RETOPIC_MS);
  }

  #close(): void {
    if (!this.#source) return;
    this.#source.onopen = null;
    this.#source.onerror = null;
    this.#source.close();
    this.#source = undefined;
  }

  #open(): void {
    this.#close();
    if (this.#stopped || this.#topicsKey === undefined) return;
    const params = new URLSearchParams();
    if (this.#topicsKey) params.set('topics', this.#topicsKey);
    // A new EventSource cannot send Last-Event-ID: the server reads it from here as well
    if (this.#lastId) params.set('last', this.#lastId);
    const source = this.#connect(`${this.#path}?${params.toString()}`);
    this.counts.connects++;
    this.#source = source;
    this.#armDown();
    source.onopen = () => {
      this.#attempt = 0;
      this.#calm();
      this.#setStatus('live');
    };
    // Whatever the cause (a proxy cut, a 429, a deploy), the reconnect is this client's, with backoff
    source.onerror = () => {
      if (this.#source !== source) return;
      this.#close();
      if (this.#status === 'live') this.#setStatus('connecting');
      this.#armDown();
      const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** this.#attempt) * (0.75 + this.#random() * 0.5);
      this.#attempt++;
      this.#retry = this.#clock.setTimeout(() => {
        this.#retry = undefined;
        this.#open();
      }, wait);
    };
    for (const kind of KINDS) source.addEventListener(kind, (e) => this.#onMessage(kind, e));
    source.addEventListener('resync', (e) => {
      if (e.lastEventId) this.#lastId = e.lastEventId;
      this.#reloadAll();
    });
  }

  /** Not open within DOWN_AFTER_MS: say so and poll slowly until it is */
  #armDown(): void {
    if (this.#downTimer !== undefined || this.#status === 'down') return;
    this.#downTimer = this.#clock.setTimeout(() => {
      this.#downTimer = undefined;
      if (this.#status === 'live') return;
      this.#setStatus('down');
      this.#poll ??= this.#clock.setInterval(() => this.#reloadAll(), FALLBACK_POLL_MS);
    }, DOWN_AFTER_MS);
  }

  /** Up again: no poll, and no pending "down" */
  #calm(): void {
    if (this.#downTimer !== undefined) this.#clock.clearTimeout(this.#downTimer);
    this.#downTimer = undefined;
    if (this.#poll !== undefined) this.#clock.clearInterval(this.#poll);
    this.#poll = undefined;
  }

  #onMessage(kind: LiveKind, message: { data: string; lastEventId: string }): void {
    if (message.lastEventId) this.#lastId = message.lastEventId;
    let data: LivePayload = {};
    try {
      data = JSON.parse(message.data) as LivePayload;
    } catch {
      // A malformed event still says its kind changed
    }
    this.dispatch({ kind, data });
  }

  /** One event to every interest that wants it: their own handler now, their reload once the burst settles */
  dispatch(event: LiveEvent): void {
    for (const entry of this.#entries) {
      if (!interestWants(entry.interest, event)) continue;
      entry.interest.onEvent?.(event);
      this.#debounce(entry);
    }
  }

  #debounce(entry: Entry): void {
    if (entry.timer !== undefined) this.#clock.clearTimeout(entry.timer);
    entry.timer = this.#clock.setTimeout(() => {
      entry.timer = undefined;
      if (!this.#entries.has(entry)) return;
      this.counts.reloads++;
      entry.interest.reload();
    }, entry.interest.debounceMs ?? DEBOUNCE_MS);
  }

  #reloadAll(): void {
    for (const entry of this.#entries) this.#debounce(entry);
  }
}
