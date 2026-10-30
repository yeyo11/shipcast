import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dedupeKeyOf, repositoriesOn } from '../src/index.ts';
import { connectPglite, migrateDatabase } from '../src/db/connect.ts';

/*
 * Migration 0021 (docs/launch-triggers.md): every launch claimed before each claim carried its dedupe
 * key gets the key its repo and ref imply, so a trigger or a manual launch of the same release, the
 * same article or the same repo gone public finds it. Only adds a value; a key two old rows would
 * share is given to the older one, and the migration never fails on it.
 */

// Production as migration 0020 left it: releases, articles, two goings-public of one repo, a launch
// keyed already (by a trigger) and a hidden one; only the keyed one has a dedupe key
const BEFORE = `
  INSERT INTO launches (id, repo, ref, trigger, kind, brand, status, detail, created_at, updated_at) VALUES
    (1, 'yeyo11/claudio', 'v0.9.0', 'manual', 'launch', 'personal', 'published', 'https://github.com/yeyo11/launches/pull/1', '2026-10-24T20:00:00.000Z', '2026-10-24T23:00:00.000Z'),
    (3, 'yeyo11/launches', 'article:monto-rea', 'article', 'launch', 'personal', 'published', 'https://github.com/yeyo11/launches/pull/10', '2026-10-27T00:00:00.000Z', '2026-10-27T00:00:00.000Z'),
    (5, 'yeyo11/tool', 'public:111', 'public', 'launch', 'personal', 'drafted', null, '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z'),
    (6, 'yeyo11/tool', 'public:webhook-public-yeyo11/tool', 'public', 'launch', 'personal', 'failed', 'no pack', '2026-10-28T00:01:00.000Z', '2026-10-28T00:01:00.000Z'),
    (8, 'yeyo11/shipcast', 'v0.2.1', 'release', 'minor', 'personal', 'drafted', null, '2026-10-29T00:00:00.000Z', '2026-10-29T00:00:00.000Z'),
    (9, 'yeyo11/shipcast', 'v0.3.0', 'release', 'minor', 'personal', 'published', null, '2026-10-29T01:00:00.000Z', '2026-10-29T01:00:00.000Z');
  UPDATE launches SET dedupe_key = 'github-release:yeyo11/shipcast@v0.2.1' WHERE id = 8;
  UPDATE launches SET deleted_at = '2026-10-29T02:00:00.000Z' WHERE id = 9;
  SELECT setval(pg_get_serial_sequence('launches', 'id'), 9);
`;

test('migration 0021 gives every old launch the dedupe key its repo and ref imply, the older one where two would share it', async () => {
  const { db, client, close } = await connectPglite(undefined, { upTo: '0020_launch_deletions' });
  try {
    await client.exec(BEFORE);
    await migrateDatabase(db);
    const { rows } = await client.query<{ id: number; dedupe_key: string | null }>('SELECT id, dedupe_key FROM launches ORDER BY id');
    assert.deepEqual(rows, [
      { id: 1, dedupe_key: 'github-release:yeyo11/claudio@v0.9.0' },
      { id: 3, dedupe_key: 'article:monto-rea' },
      { id: 5, dedupe_key: 'github-public:yeyo11/tool' },
      { id: 6, dedupe_key: null },
      { id: 8, dedupe_key: 'github-release:yeyo11/shipcast@v0.2.1' },
      { id: 9, dedupe_key: 'github-release:yeyo11/shipcast@v0.3.0' },
    ]);
    // The SQL and the code agree on every key
    for (const { id, dedupe_key } of rows.filter((r) => r.dedupe_key !== null)) {
      const launch = (await repositoriesOn(db).launches.get(id))!;
      assert.equal(dedupe_key, dedupeKeyOf(launch));
    }
    // A later claim of an old launch's release, or of its repo going public again, is the old launch
    const registry = repositoriesOn(db);
    const again = await registry.launches.claim({ repo: 'yeyo11/tool', ref: 'public:222', trigger: 'public', kind: 'launch', brand: 'personal' });
    assert.deepEqual({ claimed: again.claimed, id: again.launch.id }, { claimed: false, id: 5 });
  } finally {
    await close();
  }
});
