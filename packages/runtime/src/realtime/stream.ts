import { randomBytes } from 'node:crypto';
import type { EventBus, ShipcastEvents, Unsubscribe } from '../redis/ports.ts';

/*
 * The other half of phase 9 (docs/plans/performance-refactor.md, "6. A live UI"): one server-sent
 * event stream per open tab, fed by the event bus (Redis pub/sub across replicas with `redis-state`,
 * this process's memory without), so a page reloads what it shows when, and only when, it changed.
 *
 * The protocol, GET /api/events:
 *
 * - `?topics=` the events the tab wants, comma-separated: a kind (`launch`) for all of that kind, or
 *   `kind:launchId` (`job:12`) for one launch's. None: every kind.
 * - Each event is `id: <boot>.<seq>`, `event: <kind>`, `data: {"launchId":..,...}`: ids only, the
 *   page reads the data from its loader. Seq grows by one per event in this process; boot names the
 *   process, so an id from another replica (or before a restart) is told apart from a gap.
 * - A reconnect sends the last id it saw (`Last-Event-ID`, or `?last=` for a new EventSource, which
 *   cannot set the header): what it missed is replayed from a short ring. When the ring no longer
 *   reaches back that far, the id is another process's, or the bus itself dropped events (a Redis
 *   reconnect), the stream sends one `resync` instead, and the page reloads its data once.
 * - `: hb` every 25 s, under the idle timeouts of Traefik and Cloudflare (100 s) and of browsers.
 * - At most MAX_PER_SESSION streams per session (429 past it); none while the process drains (503),
 *   and every open one is closed when the drain starts, so the HTTP server's stop does not wait for
 *   streams that never end on their own. EventSource reconnects to a replica that is up.
 */

/** What a tab can subscribe to, each the projection of one bus event */
export const LIVE_KINDS = ['launch', 'post', 'job', 'comment', 'metrics', 'account', 'attention', 'settings'] as const;
export type LiveKind = (typeof LIVE_KINDS)[number];

/** The bus events the pages hear, and the kind each is sent as */
export const LIVE_EVENTS = {
  'launch.changed': 'launch',
  'post.changed': 'post',
  'job.changed': 'job',
  'comment.changed': 'comment',
  'metrics.changed': 'metrics',
  'account.changed': 'account',
  'attention.changed': 'attention',
  'settings.changed': 'settings',
} as const satisfies Partial<Record<keyof ShipcastEvents, LiveKind>>;

type LiveEventName = keyof typeof LIVE_EVENTS;

export interface LiveEvent {
  seq: number;
  kind: LiveKind;
  /** The launch it concerns, for the `kind:launchId` topics; null for what belongs to none */
  launchId: number | null;
  data: string;
  at: number;
}

/** What a stream asked for: kinds whole, and kinds narrowed to launches */
export interface Topics {
  all: ReadonlySet<LiveKind>;
  launches: ReadonlyMap<LiveKind, ReadonlySet<number>>;
}

/** `launch,job:12,post:12`, or nothing for everything; undefined when a topic is not one */
export function parseTopics(value: string | null): Topics | undefined {
  const all = new Set<LiveKind>();
  const launches = new Map<LiveKind, Set<number>>();
  const parts = (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return { all: new Set(LIVE_KINDS), launches };
  if (parts.length > 64) return undefined;
  for (const part of parts) {
    const match = /^([a-z]+)(?::(\d{1,12}))?$/.exec(part);
    const kind = match?.[1] as LiveKind | undefined;
    if (!match || !kind || !(LIVE_KINDS as readonly string[]).includes(kind)) return undefined;
    if (match[2] === undefined) all.add(kind);
    else {
      const set = launches.get(kind) ?? new Set<number>();
      set.add(Number(match[2]));
      launches.set(kind, set);
    }
  }
  return { all, launches };
}

export function wants(topics: Topics, event: Pick<LiveEvent, 'kind' | 'launchId'>): boolean {
  if (topics.all.has(event.kind)) return true;
  return event.launchId !== null && (topics.launches.get(event.kind)?.has(event.launchId) ?? false);
}

const encoder = new TextEncoder();

export const HEARTBEAT_MS = 25_000;
/** How many events a reconnect can catch up on, and for how long */
export const RING_SIZE = 512;
export const RING_MS = 5 * 60_000;
/** Tabs per session: a few windows of the app, never a runaway loop of reconnects */
export const MAX_PER_SESSION = 8;
/** What EventSource waits before reconnecting after a stream ends (the client adds its own backoff) */
export const RETRY_MS = 3000;

export interface LiveHubOptions {
  bus: Pick<EventBus, 'subscribe' | 'onReconnect'>;
  heartbeatMs?: number;
  ringSize?: number;
  ringMs?: number;
  maxPerSession?: number;
  /** Names this process in the ids; random by default */
  boot?: string;
  now?: () => number;
}

interface Connection {
  session: string;
  topics: Topics;
  send(chunk: string): void;
  close(): void;
}

/** One per process that serves pages: the bus subscription, the ring and the open streams */
export class LiveHub {
  readonly boot: string;
  readonly #bus: LiveHubOptions['bus'];
  readonly #heartbeatMs: number;
  readonly #ringSize: number;
  readonly #ringMs: number;
  readonly #maxPerSession: number;
  readonly #now: () => number;
  readonly #ring: LiveEvent[] = [];
  readonly #connections = new Set<Connection>();
  #seq = 0;
  /** Every event after this seq is in the ring, or never happened; at or before it, a gap */
  #floor = 0;
  #draining = false;
  #heartbeat: NodeJS.Timeout | undefined;
  #unsubscribe: Unsubscribe[] = [];
  #stopReconnect: (() => void) | undefined;
  #started: Promise<void> | undefined;

  constructor(options: LiveHubOptions) {
    this.#bus = options.bus;
    this.#heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.#ringSize = options.ringSize ?? RING_SIZE;
    this.#ringMs = options.ringMs ?? RING_MS;
    this.#maxPerSession = options.maxPerSession ?? MAX_PER_SESSION;
    this.#now = options.now ?? Date.now;
    this.boot = options.boot ?? randomBytes(4).toString('hex');
  }

  /** Subscribes to the bus once; resolves when an event published after it is heard */
  start(): Promise<void> {
    this.#started ??= (async () => {
      for (const name of Object.keys(LIVE_EVENTS) as LiveEventName[]) {
        this.#unsubscribe.push(await this.#bus.subscribe(name, (payload) => this.#accept(name, payload)));
      }
      // The bus was away: what it carried meanwhile is lost to everyone, so every page reads again
      this.#stopReconnect = this.#bus.onReconnect(() => this.gap());
    })();
    return this.#started;
  }

  /** The streams open now, for the health answer and the tests */
  get connections(): number {
    return this.#connections.size;
  }

  get lastId(): string {
    return `${this.boot}.${this.#seq}`;
  }

  #accept(name: LiveEventName, payload: unknown): void {
    const kind = LIVE_EVENTS[name];
    const launchId = typeof payload === 'object' && payload !== null && 'launchId' in payload && typeof payload.launchId === 'number' ? payload.launchId : null;
    const event: LiveEvent = { seq: ++this.#seq, kind, launchId, data: JSON.stringify(payload ?? {}), at: this.#now() };
    this.#ring.push(event);
    this.#trim();
    const frame = `id: ${this.boot}.${event.seq}\nevent: ${kind}\ndata: ${event.data}\n\n`;
    for (const connection of this.#connections) if (wants(connection.topics, event)) connection.send(frame);
  }

  #trim(): void {
    const oldest = this.#now() - this.#ringMs;
    while (this.#ring.length > this.#ringSize || (this.#ring[0] && this.#ring[0].at < oldest)) {
      const dropped = this.#ring.shift();
      if (dropped) this.#floor = dropped.seq;
    }
  }

  /** Events may have been missed (the bus reconnected): every stream resyncs, no reconnect replays across it */
  gap(): void {
    this.#floor = this.#seq;
    this.#ring.length = 0;
    for (const connection of this.#connections) connection.send(this.#resync());
  }

  #resync(): string {
    return `id: ${this.lastId}\nevent: resync\ndata: {}\n\n`;
  }

  /** What a reconnect from `last` missed, or a resync when that cannot be told */
  #catchUp(last: string | null, topics: Topics): string {
    if (!last) return '';
    const match = /^([0-9a-f]+)\.(\d+)$/.exec(last);
    const seq = match ? Number(match[2]) : NaN;
    if (!match || match[1] !== this.boot || !Number.isSafeInteger(seq) || seq > this.#seq) return this.#resync();
    this.#trim();
    if (seq < this.#floor) return this.#resync();
    return this.#ring
      .filter((e) => e.seq > seq && wants(topics, e))
      .map((e) => `id: ${this.boot}.${e.seq}\nevent: ${e.kind}\ndata: ${e.data}\n\n`)
      .join('');
  }

  /**
   * A tab's stream. `session` is who asks, already signed in (start.ts checked it): the cap counts
   * per session. The stream ends when the client goes (the request's signal, or the body cancelled)
   * or the process drains.
   */
  open(request: Request, session: string): Response {
    if (this.#draining) return new Response('Stopping: reconnect in a moment', { status: 503, headers: { 'retry-after': '2' } });
    const url = new URL(request.url);
    const topics = parseTopics(url.searchParams.get('topics'));
    if (!topics) return new Response(`topics are ${LIVE_KINDS.join(', ')}, each alone or as kind:launchId`, { status: 400 });
    let mine = 0;
    for (const c of this.#connections) if (c.session === session) mine++;
    if (mine >= this.#maxPerSession) return new Response('Too many open streams for this session', { status: 429, headers: { 'retry-after': '30' } });
    this.#ensureHeartbeat();

    let connection: Connection | undefined;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let open = true;
        const close = () => {
          if (!open) return;
          open = false;
          if (connection) this.#connections.delete(connection);
          request.signal.removeEventListener('abort', close);
          try {
            controller.close();
          } catch {
            // The client already went
          }
          this.#maybeStopHeartbeat();
        };
        connection = {
          session,
          topics,
          send: (chunk) => {
            if (!open) return;
            try {
              controller.enqueue(encoder.encode(chunk));
            } catch {
              close();
            }
          },
          close,
        };
        this.#connections.add(connection);
        request.signal.addEventListener('abort', close, { once: true });
        connection.send(`retry: ${RETRY_MS}\n: ${this.lastId}\n\n${this.#catchUp(request.headers.get('last-event-id') ?? url.searchParams.get('last'), topics)}`);
        if (request.signal.aborted) close();
      },
      cancel: () => connection?.close(),
    });
    return new Response(body, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        // no-transform: Cloudflare and any other proxy must not compress (and so hold back) the stream
        'cache-control': 'no-cache, no-store, no-transform',
        // nginx and the proxies that honour it pass each event on at once; Traefik flushes event streams by itself
        'x-accel-buffering': 'no',
      },
    });
  }

  /** One timer for every stream: a comment line keeps each alive past the proxies' idle timeouts */
  #ensureHeartbeat(): void {
    if (this.#heartbeat) return;
    this.#heartbeat = setInterval(() => {
      for (const connection of this.#connections) connection.send(': hb\n\n');
    }, this.#heartbeatMs);
    this.#heartbeat.unref();
  }

  #maybeStopHeartbeat(): void {
    if (this.#connections.size > 0 || !this.#heartbeat) return;
    clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
  }

  /** The stop's HTTP step: no new stream, every open one closed, the bus left */
  async drain(): Promise<void> {
    this.#draining = true;
    for (const connection of [...this.#connections]) connection.close();
    this.#maybeStopHeartbeat();
    this.#stopReconnect?.();
    await Promise.all(this.#unsubscribe.splice(0).map((u) => u().catch(() => undefined)));
  }
}
