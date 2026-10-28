import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BACKOFF_MS, DEBOUNCE_MS, DOWN_AFTER_MS, FALLBACK_POLL_MS, LiveClient, topicsOf, type Clock, type EventSourceLike, type Interest, type LiveKind, type Topic } from '../src/components/live/client.ts';

/*
 * Phase 9's client (components/live/client.ts) with a fake clock and a fake EventSource: which
 * events reload which page, that a burst is one reload, the backoff and the slow poll when the
 * stream is down, and the KPI of docs/plans/performance-refactor.md: an idle open tab makes under one
 * request a minute.
 */

/** Timers that run only when the test moves time on */
class FakeClock implements Clock {
  now = 0;
  #next = 1;
  readonly #timers = new Map<number, { at: number; fn: () => void; every?: number }>();

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#timers.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }
  setInterval(fn: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#timers.set(id, { at: this.now + ms, fn, every: ms });
    return id;
  }
  clearInterval(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.#timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      this.now = timer.at;
      if (timer.every) timer.at += timer.every;
      else this.#timers.delete(id);
      timer.fn();
    }
    this.now = end;
  }
}

class FakeSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: never) => void) | null = null;
  onerror: ((event: never) => void) | null = null;
  closed = false;
  readonly #listeners = new Map<string, Array<(e: { data: string; lastEventId: string }) => void>>();
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (e: { data: string; lastEventId: string }) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.(undefined as never);
  }
  fail(): void {
    this.onerror?.(undefined as never);
  }
  emit(kind: LiveKind | 'resync', data: object, id: string): void {
    for (const l of this.#listeners.get(kind) ?? []) l({ data: JSON.stringify(data), lastEventId: id });
  }
}

function setup() {
  const clock = new FakeClock();
  const sources: FakeSource[] = [];
  const client = new LiveClient({
    clock,
    random: () => 0.5,
    connect: (url) => {
      const s = new FakeSource(url);
      sources.push(s);
      return s;
    },
  });
  const current = () => sources.at(-1)!;
  return { clock, client, sources, current };
}

/** An interest that counts its reloads */
function counting(topics: Topic[], extra: Partial<Interest> = {}) {
  const interest = { topics, reloads: 0, reload() {}, ...extra } as Interest & { reloads: number };
  interest.reload = () => void interest.reloads++;
  return interest;
}

/** The launch page of launch 12 and the bell, as the routes register them */
const launchPage = () => counting(['launch:12', 'post:12', 'job:12', 'comment:12', 'metrics:12']);
const bell = () => counting(['attention', 'launch', 'post', 'comment', 'account']);

describe('which events reload which page', () => {
  test("the launch page reloads on its launch's events only, once per burst", () => {
    const { clock, client, current } = setup();
    const page = launchPage();
    client.register(page);
    clock.advance(100);
    current().open();
    current().emit('job', { id: 'x', state: 'active', launchId: 13 }, 'b.1');
    current().emit('metrics', { launchId: 13 }, 'b.2');
    clock.advance(DEBOUNCE_MS * 2);
    assert.equal(page.reloads, 0, "another launch's job and numbers are not this page's");
    for (let i = 0; i < 5; i++) current().emit('job', { id: 'j', state: 'active', launchId: 12 }, `b.${3 + i}`);
    current().emit('post', { postId: 1, launchId: 12 }, 'b.8');
    clock.advance(DEBOUNCE_MS - 1);
    assert.equal(page.reloads, 0, 'still waiting for the burst to settle');
    clock.advance(1);
    assert.equal(page.reloads, 1, "six events of this launch: one reload");
  });

  test('the bell hears every launch, the launch page only its own; settings reload neither', () => {
    const { clock, client, current } = setup();
    const page = launchPage();
    const theBell = bell();
    client.register(page);
    client.register(theBell);
    clock.advance(100);
    current().open();
    current().emit('launch', { launchId: 40 }, 'b.1');
    clock.advance(DEBOUNCE_MS);
    assert.deepEqual([page.reloads, theBell.reloads], [0, 1]);
    current().emit('settings', { key: 'settings' }, 'b.2');
    clock.advance(DEBOUNCE_MS);
    assert.deepEqual([page.reloads, theBell.reloads], [0, 1]);
  });

  test("an interest's own filter: a profile review hears its job's end and nothing else", () => {
    const { clock, client, current } = setup();
    const ended: string[] = [];
    const review = counting(['job'], { accepts: (e) => e.data.id === 'review-1' && e.data.state === 'completed', onEvent: (e) => ended.push(e.data.id ?? ''), debounceMs: 0 });
    client.register(review);
    clock.advance(100);
    current().open();
    current().emit('job', { id: 'review-1', state: 'active', launchId: null }, 'b.1');
    current().emit('job', { id: 'other', state: 'completed', launchId: null }, 'b.2');
    current().emit('job', { id: 'review-1', state: 'completed', launchId: null }, 'b.3');
    clock.advance(1);
    assert.deepEqual(ended, ['review-1']);
    assert.equal(review.reloads, 1);
  });

  test('a resync reloads every page part once', () => {
    const { clock, client, current } = setup();
    const page = launchPage();
    const theBell = bell();
    client.register(page);
    client.register(theBell);
    clock.advance(100);
    current().open();
    current().emit('resync', {}, 'b.9');
    clock.advance(DEBOUNCE_MS);
    assert.deepEqual([page.reloads, theBell.reloads], [1, 1]);
  });

  test("the stream carries the union of the page's topics, and a navigation reopens it where it was", () => {
    assert.deepEqual(topicsOf([{ topics: ['job:12', 'launch:12'] }, { topics: ['launch', 'post'] }]), ['launch', 'post', 'job:12']);
    const { clock, client, sources, current } = setup();
    const offBell = client.register(bell());
    const offPage = client.register(launchPage());
    clock.advance(100);
    assert.equal(sources.length, 1, 'the parts registered together make one stream');
    assert.equal(decodeURIComponent(new URL(current().url, 'https://x').searchParams.get('topics') ?? ''), 'account,attention,comment,launch,post,job:12,metrics:12');
    current().open();
    current().emit('launch', { launchId: 12 }, 'b0.7');
    offPage();
    offBell();
    client.register(bell());
    clock.advance(100);
    assert.equal(sources.length, 2);
    assert.equal(sources[0]?.closed, true);
    assert.equal(new URL(current().url, 'https://x').searchParams.get('last'), 'b0.7', 'the new stream resumes from the last event seen');
  });
});

describe('when the stream is down', () => {
  test('reconnects with a growing backoff, then says so and polls once a minute until it is back', () => {
    const { clock, client, sources, current } = setup();
    const page = launchPage();
    const statuses: string[] = [];
    client.onStatus((s) => statuses.push(s));
    client.register(page);
    clock.advance(100);
    current().fail();
    clock.advance(BACKOFF_MS - 1);
    assert.equal(sources.length, 1);
    clock.advance(1);
    assert.equal(sources.length, 2, 'first retry after a second');
    current().fail();
    clock.advance(BACKOFF_MS * 2);
    assert.equal(sources.length, 3, 'then two');
    assert.equal(page.reloads, 0);
    clock.advance(DOWN_AFTER_MS);
    assert.equal(client.status, 'down');
    const before = page.reloads;
    clock.advance(FALLBACK_POLL_MS + DEBOUNCE_MS);
    assert.equal(page.reloads, before + 1, 'one slow poll a minute, no faster');
    // Back: no more polling
    for (const s of sources) if (!s.closed) s.open();
    clock.advance(10 * 60_000);
    current().open();
    const after = page.reloads;
    clock.advance(5 * 60_000);
    assert.equal(page.reloads, after);
    assert.equal(client.status, 'live');
    assert.ok(statuses.includes('down') && statuses.at(-1) === 'live');
  });
});

describe('an idle open tab', () => {
  test('five minutes with nothing changing: one stream, no reconnect, no data request', () => {
    const { clock, client, sources, current } = setup();
    // The launch page as the shell mounts it: the page and the bell
    const page = launchPage();
    const theBell = bell();
    client.register(page);
    client.register(theBell);
    clock.advance(100);
    current().open();
    // The server's heartbeat is a comment line: EventSource never surfaces it, so nothing runs
    clock.advance(5 * 60_000);
    assert.equal(sources.length, 1, 'one request: the stream itself');
    assert.equal(client.counts.connects, 1);
    assert.equal(page.reloads + theBell.reloads, 0, 'no loader re-run');
    assert.equal(client.counts.reloads, 0);
    const perMinute = (client.counts.connects + client.counts.reloads) / 5;
    assert.ok(perMinute < 1, `${perMinute} requests a minute`);
  });

  test('the same five minutes with today’s polling would have made 60 reads of the launch page', () => {
    // The launch page's setInterval while a job runs (5 s), for comparison with the number above
    const clock = new FakeClock();
    let reads = 0;
    clock.setInterval(() => reads++, 5000);
    clock.advance(5 * 60_000);
    assert.equal(reads, 60);
  });
});
