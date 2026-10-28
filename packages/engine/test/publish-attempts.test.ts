import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorError } from '@shipcast/connectors';
import { PieceGuard, PublishAttempts, type Piece } from '../src/index.ts';
import { memoryRegistry as memory } from '../src/testing.ts';

async function setup() {
  const registry = await memory();
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/shipcast', ref: 'v0.2.0', trigger: 'release', kind: 'major', brand: 'personal' });
  const piece: Piece = { launchId: launch.id, channel: 'bluesky', kind: 'post' };
  return { registry, attempts: new PublishAttempts(registry.database), piece };
}

test('of ten workers claiming one piece at once, exactly one gets it', async () => {
  const { attempts, piece } = await setup();
  const claims = await Promise.all(Array.from({ length: 10 }, (_, i) => attempts.claim(piece, { holder: `job-${i}`, idempotent: false })));
  assert.equal(claims.filter((c) => c.claimed).length, 1);
  const stored = await attempts.get(piece);
  assert.equal(stored?.state, 'attempting');
  assert.equal(stored?.attempts, 1);
});

test('two guarded sends of one piece at once call the network once', async () => {
  const { attempts, piece } = await setup();
  let calls = 0;
  const send = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 20));
    return { externalId: 'at://1', url: 'https://bsky.app/1' };
  };
  const [a, b] = await Promise.all([new PieceGuard(attempts, 'round').run(piece, { idempotent: false }, send), new PieceGuard(attempts, 'job-1').run(piece, { idempotent: false }, send)]);
  assert.equal(calls, 1);
  assert.equal([a, b].filter((r) => r.ran).length, 1);
  const stored = await attempts.get(piece);
  assert.equal(stored?.state, 'live');
  assert.equal(stored?.externalId, 'at://1');
  // Live is final: no later worker sends it again
  const later = await new PieceGuard(attempts, 'job-2').run(piece, { idempotent: true }, send);
  assert.equal(later.ran, false);
  assert.equal(calls, 1);
});

test('a temporary failure is claimed again by the next run; a refusal waits, then Try again resets it', async () => {
  const { attempts, piece } = await setup();
  const guard = new PieceGuard(attempts, 'job-1');
  await assert.rejects(guard.run(piece, { idempotent: false }, () => Promise.reject(new ConnectorError('Bluesky', '503', 503))), /503/);
  assert.equal((await attempts.get(piece))?.state, 'retryable');
  await assert.rejects(guard.run(piece, { idempotent: false }, () => Promise.reject(new ConnectorError('Bluesky', 'refused', 400))), /refused/);
  const failed = await attempts.get(piece);
  assert.equal(failed?.state, 'failed');
  assert.equal(failed?.attempts, 2);
  assert.equal(await attempts.reset(piece.launchId, piece.channel), 1);
  assert.equal(await attempts.get(piece), undefined);
});

test('a worker that died mid-call: an idempotent network is tried again, any other becomes unknown', async () => {
  const { attempts, piece } = await setup();
  const then = new Date('2026-10-28T12:00:00Z');
  const later = new Date('2026-10-28T13:00:00Z');
  await attempts.claim(piece, { holder: 'dead', idempotent: false, now: then, leaseMs: 60_000 });

  // Still within the lease: nobody takes it
  const early = await attempts.claim(piece, { holder: 'job-2', idempotent: true, now: new Date(then.getTime() + 30_000) });
  assert.equal(early.claimed, false);

  const unknown = await attempts.claim(piece, { holder: 'job-2', idempotent: false, now: later });
  assert.equal(unknown.claimed, false);
  assert.equal(unknown.attempt.state, 'unknown');
  // Unknown is not taken over by anyone, idempotent or not, until the owner says
  assert.equal((await attempts.claim(piece, { holder: 'job-3', idempotent: true, now: later })).claimed, false);

  const other: Piece = { ...piece, channel: 'mastodon' };
  await attempts.claim(other, { holder: 'dead', idempotent: true, now: then, leaseMs: 60_000 });
  const again = await attempts.claim(other, { holder: 'job-2', idempotent: true, now: later });
  assert.equal(again.claimed, true);
  assert.equal(again.attempt.attempts, 2);
});

test('a late answer from a stale holder never overwrites the new holder’s attempt', async () => {
  const { attempts, piece } = await setup();
  const then = new Date('2026-10-28T12:00:00Z');
  await attempts.claim(piece, { holder: 'slow', idempotent: true, now: then, leaseMs: 1000 });
  await attempts.claim(piece, { holder: 'fast', idempotent: true, now: new Date(then.getTime() + 5000) });
  await attempts.fail(piece, 'slow', { error: 'timed out', retryable: true });
  assert.equal((await attempts.get(piece))?.state, 'attempting', 'the slow holder no longer owns it');
  await attempts.succeed(piece, 'fast', { externalId: '1', url: 'https://x/1' });
  assert.equal((await attempts.get(piece))?.state, 'live');
});
