import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repositoriesOn } from '../src/index.ts';
import { connectPglite, migrateDatabase } from '../src/db/connect.ts';

// Production as migration 0017 left it: a published release, an article and a failed launch, with posts and an attempt
const BEFORE = `
  INSERT INTO launches (id, repo, ref, trigger, kind, brand, status, detail, created_at, updated_at) VALUES
    (1, 'yeyo11/claudio', 'v0.9.0', 'manual', 'launch', 'personal', 'published', 'https://github.com/yeyo11/launches/pull/1', '2026-10-24T20:00:00.000Z', '2026-10-24T23:00:00.000Z'),
    (6, 'yeyo11/launches', 'article:monto-rea', 'article', 'launch', 'personal', 'published', 'https://github.com/yeyo11/launches/pull/10', '2026-10-27T00:00:00.000Z', '2026-10-27T00:00:00.000Z'),
    (7, 'yeyo11/shipcast', 'v0.2.0', 'release', 'major', 'personal', 'failed', 'no pack', '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z');
  SELECT setval(pg_get_serial_sequence('launches', 'id'), 7);
  INSERT INTO posts (launch_id, channel, kind, external_id, url) VALUES (1, 'blog', 'article:en', 'a', 'https://example.dev/en/a/');
  INSERT INTO publish_attempts (launch_id, channel, kind, state) VALUES (6, 'devto', 'post', 'live');
`;

async function migrated() {
  const connection = await connectPglite(undefined, { upTo: '0017_metric_days' });
  await connection.client.exec(BEFORE);
  await migrateDatabase(connection.db);
  return connection;
}

test('the launch model migration only adds: every launch, post and attempt reads as before, the new columns empty', async () => {
  const { db, client, close } = await migrated();
  try {
    const registry = repositoriesOn(db);
    const claudio = await registry.launches.get(1);
    assert.deepEqual(
      { repo: claudio?.repo, ref: claudio?.ref, status: claudio?.status, detail: claudio?.detail },
      { repo: 'yeyo11/claudio', ref: 'v0.9.0', status: 'published', detail: 'https://github.com/yeyo11/launches/pull/1' },
    );
    // Only `model`, which the fifth phase reads (docs/app-review.md): legacy for every launch from before
    assert.deepEqual(Object.keys(claudio ?? {}).sort(), ['brand', 'createdAt', 'detail', 'id', 'kind', 'model', 'ref', 'repo', 'status', 'trigger', 'updatedAt'], 'the Launch the app reads has only the model added');
    assert.equal(claudio?.model, 'legacy');
    const { rows } = await client.query<Record<string, unknown>>('SELECT id, title, model, dedupe_key, channels_source, deleted_at, approved_at FROM launches ORDER BY id');
    assert.deepEqual(rows, [1, 6, 7].map((id) => ({ id, title: null, model: 'legacy', dedupe_key: null, channels_source: null, deleted_at: null, approved_at: null })));
    assert.deepEqual((await client.query('SELECT draft_version_id FROM posts')).rows, [{ draft_version_id: null }]);
    assert.deepEqual((await client.query('SELECT draft_version_id, approval_id FROM publish_attempts')).rows, [{ draft_version_id: null, approval_id: null }]);
    for (const table of ['launch_sources', 'launch_channels', 'packs', 'drafts', 'draft_versions', 'media', 'approvals']) {
      assert.deepEqual((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows, [{ n: 0 }], `${table} starts empty`);
    }
    // The claim of today still holds
    assert.equal((await registry.launches.claim({ repo: 'yeyo11/shipcast', ref: 'v0.2.0', trigger: 'release', kind: 'major', brand: 'personal' })).claimed, false);
  } finally {
    await close();
  }
});

test('a dedupe key is claimed once, while any number of launches go without one', async () => {
  const { client, close } = await migrated();
  try {
    await client.exec(`UPDATE launches SET dedupe_key = 'github-release:yeyo11/claudio@v0.9.0' WHERE id = 1`);
    await client.exec(`INSERT INTO launches (repo, ref, trigger, kind, brand, status) VALUES ('-', 'launch:a', 'manual', 'launch', 'personal', 'detected'), ('-', 'launch:b', 'manual', 'launch', 'personal', 'detected')`);
    await assert.rejects(
      client.exec(`INSERT INTO launches (repo, ref, trigger, kind, brand, status, dedupe_key) VALUES ('-', 'launch:c', 'release', 'launch', 'personal', 'detected', 'github-release:yeyo11/claudio@v0.9.0')`),
      /launches_dedupe_key_unique/,
    );
  } finally {
    await close();
  }
});

test("a launch's sources, channels, packs, drafts, versions, media and approvals hang on it, and a purge takes them all", async () => {
  const { client, close } = await migrated();
  try {
    await client.exec(`
      INSERT INTO media (launch_id, sha256, kind, mime, bytes, storage, path, role) VALUES
        (1, '${'a'.repeat(64)}', 'image', 'image/png', 3000000000, 'r2', 'media/aa/${'a'.repeat(64)}', 'og');
      INSERT INTO launch_sources (launch_id, position, kind, role, repo, ref) VALUES (1, 0, 'repo_release', 'primary', 'yeyo11/claudio', 'v0.9.0');
      INSERT INTO launch_sources (launch_id, position, kind, text, media_id) VALUES (1, 1, 'text', 'The owner''s words', 1);
      INSERT INTO launch_channels (launch_id, channel, mode, options) VALUES (1, 'reddit', 'off', '{"subreddits":["ClaudeAI"]}');
      INSERT INTO packs (launch_id, version, pack, accepted) VALUES (1, 1, '{"schemaVersion":1}', true);
      INSERT INTO drafts (launch_id, channel, piece) VALUES (1, 'bluesky', 'post');
      INSERT INTO draft_versions (draft_id, n, body, origin, pack_id) VALUES (1, 1, 'First', 'ai', 1), (1, 2, 'Second', 'owner', 1);
      UPDATE drafts SET current_version_id = 2 WHERE id = 1;
      INSERT INTO approvals (launch_id, by, versions) VALUES (1, 'yeyo11', '{"1":2}');
      UPDATE posts SET draft_version_id = 2;
    `);
    await assert.rejects(client.exec(`INSERT INTO draft_versions (draft_id, n, body, origin) VALUES (1, 2, 'Again', 'ai')`), /draft_versions_n_unique/);
    await assert.rejects(client.exec(`INSERT INTO drafts (launch_id, channel, piece) VALUES (1, 'bluesky', 'post')`), /drafts_piece_unique/);
    await assert.rejects(client.exec(`INSERT INTO media (launch_id, sha256, kind, mime, bytes, storage, path, role) VALUES (1, '${'a'.repeat(64)}', 'image', 'image/png', 1, 'r2', 'x', 'carousel')`), /media_launch_sha256_unique/);
    // The same bytes in another launch are a row of their own
    await client.exec(`INSERT INTO media (launch_id, sha256, kind, mime, bytes, storage, path, role) VALUES (6, '${'a'.repeat(64)}', 'image', 'image/png', 1, 'r2', 'x', 'og')`);

    // Posts keep no cascade: a launch with posts cannot be purged until they go
    await client.exec('DELETE FROM posts WHERE launch_id = 1');
    await client.exec('DELETE FROM launches WHERE id = 1');
    for (const table of ['launch_sources', 'launch_channels', 'packs', 'drafts', 'draft_versions', 'approvals']) {
      assert.deepEqual((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows, [{ n: 0 }], `${table} went with the launch`);
    }
    assert.deepEqual((await client.query('SELECT launch_id FROM media')).rows, [{ launch_id: 6 }], "another launch's file stays");
  } finally {
    await close();
  }
});
