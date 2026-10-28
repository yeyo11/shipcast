import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { repositoriesOn } from '../src/index.ts';
import { connectPglite } from '../src/db/connect.ts';
import { copyFromSqlite, countSqlite, NotEmpty } from '../src/db/from-sqlite.ts';

// The schema the node:sqlite registry created, as its three migrations left it
const SQLITE_SCHEMA = `
  CREATE TABLE launches (
    id INTEGER PRIMARY KEY, repo TEXT NOT NULL, ref TEXT NOT NULL, trigger TEXT NOT NULL, kind TEXT NOT NULL,
    brand TEXT NOT NULL, status TEXT NOT NULL, detail TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (repo, ref)
  );
  CREATE TABLE posts (
    launch_id INTEGER NOT NULL REFERENCES launches (id), channel TEXT NOT NULL, url TEXT, external_id TEXT,
    published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (launch_id, channel)
  );
  CREATE TABLE cursors (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE metrics (launch_id INTEGER NOT NULL REFERENCES launches (id), source TEXT NOT NULL, name TEXT NOT NULL, value REAL NOT NULL, taken_at TEXT NOT NULL);
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY, network TEXT NOT NULL, brand TEXT NOT NULL, label TEXT NOT NULL,
    settings TEXT NOT NULL DEFAULT '{}', is_primary INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'unchecked',
    identity TEXT, problem TEXT, checked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (network, brand, label)
  );
  INSERT INTO launches (id, repo, ref, trigger, kind, brand, status, detail, created_at, updated_at) VALUES
    (3, 'yeyo11/claudio', 'v0.8.0', 'release', 'launch', 'personal', 'published', 'https://github.com/yeyo11/launches/pull/1', '2026-10-01T10:00:00.000Z', '2026-10-02T10:00:00.000Z'),
    (7, 'yeyo11/claudio', 'v0.9.0', 'manual', 'minor', 'personal', 'failed', 'could not clone', '2026-10-20T10:00:00.000Z', '2026-10-20T10:05:00.000Z');
  INSERT INTO posts VALUES (3, 'devto', 'https://dev.to/x', '42', '2026-10-02T10:00:00.000Z'), (3, 'blog', 'https://example.dev/en/claudio/', 'en:claudio', '2026-10-02T09:00:00.000Z');
  INSERT INTO metrics VALUES (3, 'devto', 'views', 10, '2026-10-03T00:00:00.000Z'), (3, 'devto', 'views', 12.5, '2026-10-04T00:00:00.000Z');
  INSERT INTO cursors VALUES ('events-etag:yeyo11', 'W/"1"'), ('publish-failed:3:newsletter', 'Brevo: 405');
  INSERT INTO accounts (id, network, brand, label, settings, is_primary, status, identity, created_at) VALUES
    (5, 'mastodon', 'personal', '@me', '{"instance":"https://fosstodon.org"}', 1, 'ok', '@me@fosstodon.org', '2026-10-10T00:00:00.000Z');
`;

const dir = mkdtempSync(join(tmpdir(), 'shipcast-from-sqlite-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function sqliteRegistry(): string {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.db`);
  const db = new DatabaseSync(path);
  db.exec(SQLITE_SCHEMA);
  db.close();
  return path;
}

test('every row of a SQLite registry is copied as it was, ids included, and new ids follow them', async () => {
  const path = sqliteRegistry();
  const { db, close } = await connectPglite();
  try {
    const counts = await copyFromSqlite(path, db);
    assert.deepEqual(counts, countSqlite(path));
    assert.deepEqual(counts, { launches: 2, posts: 2, metrics: 2, cursors: 2, accounts: 1 });

    const registry = repositoriesOn(db);
    const launch = await registry.launches.get(3);
    assert.deepEqual(launch, {
      id: 3,
      repo: 'yeyo11/claudio',
      ref: 'v0.8.0',
      trigger: 'release',
      kind: 'launch',
      brand: 'personal',
      status: 'published',
      detail: 'https://github.com/yeyo11/launches/pull/1',
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-02T10:00:00.000Z',
    });
    assert.deepEqual((await registry.posts.posts(3)).map((p) => p.channel), ['blog', 'devto']);
    assert.deepEqual((await registry.metrics.metricHistory(3, 'devto', 'views')).map((m) => m.value), [10, 12.5]);
    assert.equal(await registry.launches.lastPublishedRef('yeyo11/claudio'), 'v0.8.0');
    assert.equal((await registry.accounts.primaryAccount('personal', 'mastodon'))?.settings.instance, 'https://fosstodon.org');
    assert.equal((await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v0.9.0', trigger: 'release', kind: 'minor', brand: 'personal' })).claimed, false, 'a launch moved is still claimed');

    const fresh = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'major', brand: 'personal' });
    // Above the copied ids; not 8, since the refused claim above took a number from the sequence
    assert.ok(fresh.launch.id > 7, 'the sequence starts after the copied ids');
    assert.equal((await registry.accounts.addAccount({ network: 'devto', brand: 'personal', label: 'x', settings: {} })).id, 6);
  } finally {
    await close();
  }
});

test('a database that holds rows is refused, unless forced, which empties it first', async () => {
  const path = sqliteRegistry();
  const { db, close } = await connectPglite();
  try {
    await copyFromSqlite(path, db);
    await assert.rejects(copyFromSqlite(path, db), NotEmpty);
    assert.deepEqual(await copyFromSqlite(path, db, { force: true }), countSqlite(path));
  } finally {
    await close();
  }
});
