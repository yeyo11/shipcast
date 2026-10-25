import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Registry } from '../src/index.ts';
import { connectPglite, FIRST_MIGRATION, migrateDatabase } from '../src/db/connect.ts';

// An install as the first schema left it: one row per launch and channel, the newsletter's ids
// comma-joined, Instagram's extras and the automation choices in cursors
const LEGACY = `
  INSERT INTO launches (id, repo, ref, trigger, kind, brand, status, created_at, updated_at) VALUES
    (1, 'yeyo11/claudio', 'v0.9.0', 'release', 'launch', 'personal', 'published', '2026-10-24T20:00:00.000Z', '2026-10-24T23:00:00.000Z'),
    (2, 'acme/tool', 'v1.0.0', 'release', 'launch', 'company', 'published', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
    (3, 'yeyo11/shipcast', 'v0.1.0', 'release', 'launch', 'personal', 'drafted', '2026-10-25T00:00:00.000Z', '2026-10-25T00:00:00.000Z');
  INSERT INTO accounts (id, network, brand, label, is_primary) VALUES
    (1, 'devto', 'personal', '@me', 1),
    (3, 'instagram', 'personal', '@main', 1),
    (4, 'brevo', 'personal', 'list', 1),
    (10, 'instagram', 'personal', '@other', 0);
  INSERT INTO posts (launch_id, channel, url, external_id, published_at) VALUES
    (1, 'blog', 'https://example.dev/en/a/', 'en:a,es:b', '2026-10-24T23:10:55.000Z'),
    (1, 'devto', 'https://dev.to/me/a', '4912650', '2026-10-24T23:10:57.000Z'),
    (1, 'instagram', 'https://www.instagram.com/p/X/', '1796', '2026-10-25T00:08:55.000Z'),
    (1, 'newsletter', 'https://app.brevo.com/marketing-campaign/report/8', '8,9', '2026-10-24T23:13:00.000Z'),
    (2, 'blog', 'https://other.example/en/shared/', 'shared', '2026-10-01T01:00:00.000Z'),
    (2, 'bluesky', 'https://bsky.app/x', 'at://x', '2026-10-01T01:00:01.000Z'),
    (2, 'newsletter', 'https://app.brevo.com/marketing-campaign/report/20', '20,21', '2026-10-01T01:00:02.000Z');
  INSERT INTO cursors (key, value) VALUES
    ('newsletter-sent:1:en', '{"externalId":"8","url":"https://app.brevo.com/marketing-campaign/report/8"}'),
    ('newsletter-sent:1:es', '{"externalId":"9","url":"https://app.brevo.com/marketing-campaign/report/9"}'),
    ('newsletter-sent:3:es', '{"externalId":"30","url":"https://app.brevo.com/marketing-campaign/report/30"}'),
    ('newsletter-sent:99:en', '{"externalId":"990","url":"u"}'),
    ('instagram-story:1', '1791'),
    ('instagram-comment:1', '1790'),
    ('automation:mode', 'webhook'),
    ('automation:interval', '120'),
    ('automation:last-round', '{"at":"x","summary":"s","lines":[]}'),
    ('events-etag:yeyo11', 'W/"1"'),
    ('publish-failed:3:devto', 'rejected');
  INSERT INTO metrics (launch_id, source, name, value, taken_at) VALUES
    (1, 'devto', 'views', 310, '2026-10-25T06:00:00.000Z'),
    (1, 'instagram', 'likes', 9, '2026-10-25T06:00:00.000Z'),
    (1, 'newsletter', 'clicks', 7, '2026-10-25T06:00:00.000Z'),
    (1, 'blog', 'views', 48, '2026-10-25T06:00:00.000Z'),
    (1, 'github', 'stars', 120, '2026-10-25T06:00:00.000Z');
`;

const pieces = async (registry: Registry, launchId: number) =>
  (await registry.posts(launchId)).map((p) => [p.channel, p.kind, p.accountId, p.externalId, p.url, p.status, p.publishedAt].join(' | ')).sort();

test('the post model migration converts an install in place, losing nothing', async () => {
  const { db, client, close } = await connectPglite(undefined, { upTo: FIRST_MIGRATION });
  try {
    await client.exec(LEGACY);
    await migrateDatabase(db);
    const registry = new Registry(db);

    assert.deepEqual(await pieces(registry, 1), [
      'blog | article:en |  | a | https://example.dev/en/a/ | live | 2026-10-24T23:10:55.000Z',
      'blog | article:es |  | b | https://example.dev/es/b/ | live | 2026-10-24T23:10:55.000Z',
      'devto | post | 1 | 4912650 | https://dev.to/me/a | live | 2026-10-24T23:10:57.000Z',
      'instagram | comment | 3 | 1790 |  | live | 2026-10-25T00:08:55.000Z',
      'instagram | post | 3 | 1796 | https://www.instagram.com/p/X/ | live | 2026-10-25T00:08:55.000Z',
      'instagram | story | 3 | 1791 |  | live | 2026-10-25T00:08:55.000Z',
      'newsletter | issue:en | 4 | 8 | https://app.brevo.com/marketing-campaign/report/8 | live | 2026-10-24T23:13:00.000Z',
      'newsletter | issue:es | 4 | 9 | https://app.brevo.com/marketing-campaign/report/9 | live | 2026-10-24T23:13:00.000Z',
    ]);
    // Another brand, with no accounts: nothing attributed; an old shared slug and ids with no cursors
    assert.deepEqual(await pieces(registry, 2), [
      'blog | article:en |  | shared | https://other.example/en/shared/ | live | 2026-10-01T01:00:00.000Z',
      'blog | article:es |  | shared | https://other.example/es/shared/ | live | 2026-10-01T01:00:00.000Z',
      'bluesky | post |  | at://x | https://bsky.app/x | live | 2026-10-01T01:00:01.000Z',
      'newsletter | issue:en |  | 20 | https://app.brevo.com/marketing-campaign/report/20 | live | 2026-10-01T01:00:02.000Z',
      'newsletter | issue:es |  | 21 | https://app.brevo.com/marketing-campaign/report/21 | live | 2026-10-01T01:00:02.000Z',
    ]);
    // An issue that went out while its sibling was still being retried has no post row: it gets its own
    const [spanish] = await registry.posts(3);
    assert.deepEqual([spanish?.kind, spanish?.externalId, spanish?.accountId], ['issue:es', '30', 4]);

    assert.equal(await registry.setting('automation:mode'), 'webhook');
    assert.equal(await registry.setting('automation:interval'), 120);

    const left = (await registry.cursorsWithPrefix('')).map((c) => c.key);
    assert.deepEqual(left, ['automation:last-round', 'events-etag:yeyo11', 'newsletter-sent:99:en', 'publish-failed:3:devto'], 'only state, and what had nothing to become');

    // The channels' readings point at their posts; the old newsletter sums and the site's stay the launch's
    const [devto] = await registry.posts(1, { channel: 'devto' });
    const [instagram] = await registry.posts(1, { channel: 'instagram', kind: 'post' });
    assert.deepEqual((await registry.postMetrics(devto!.id)).map((m) => `${m.name}=${m.value}`), ['views=310']);
    assert.deepEqual((await registry.postMetrics(instagram!.id)).map((m) => `${m.name}=${m.value}`), ['likes=9']);
    assert.deepEqual(
      (await registry.latestMetrics(1)).map((m) => `${m.source}.${m.name}=${m.value}`),
      ['blog.views=48', 'devto.views=310', 'github.stars=120', 'instagram.likes=9', 'newsletter.clicks=7'],
    );

    // A launch still happens once: the converted pieces refuse a second copy
    assert.equal((await registry.recordPost({ launchId: 1, channel: 'blog', kind: 'article:es', url: 'x', externalId: 'x' })).recorded, false);
    assert.equal((await registry.recordPost({ launchId: 1, channel: 'instagram', kind: 'story', accountId: 3, url: null, externalId: 'x' })).recorded, false);
    const fresh = await registry.recordPost({ launchId: 3, channel: 'devto', accountId: 1, url: 'https://dev.to/me/b', externalId: '1' });
    assert.ok(fresh.recorded && fresh.post.id > 0, 'new pieces take ids after the converted ones');

    // Applied once: starting again converts nothing twice
    await migrateDatabase(db);
    assert.equal((await registry.posts(1)).length, 8);
  } finally {
    await close();
  }
});
