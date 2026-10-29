import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorError, PostGone, YouTube, YOUTUBE_UNITS } from '../src/index.ts';
import { fakeFetch, sequence, type Call } from './fake.ts';

const TOKEN = 'POST https://oauth2.googleapis.com/token';
const token = () => Response.json({ access_token: 'at', expires_in: 3599, token_type: 'Bearer' });
const SESSION = 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=xyz';

function youtube(rules: Array<[string, () => Response]>, calls: Call[] = [], units: string[] = []) {
  return new YouTube({ clientId: 'cid', clientSecret: 'secret', refreshToken: 'rt', fetch: fakeFetch([[TOKEN, token], ...rules], calls), onUnits: (_n, call) => units.push(call) });
}

const video = { title: 'Shipcast v0.2.0', description: 'What it does', tags: ['shipcast'], lang: 'en', bytes: new Uint8Array([0, 0, 0, 1]), short: true };

test('an upload: the session, then the bytes, then captions and the thumbnail; the units of each are reported', async () => {
  const calls: Call[] = [];
  const units: string[] = [];
  const yt = youtube(
    [
      ['POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable', () => new Response(null, { status: 200, headers: { location: SESSION } })],
      [`PUT ${SESSION}`, () => Response.json({ id: 'vid1', status: { privacyStatus: 'private', uploadStatus: 'uploaded' } })],
      ['POST https://www.googleapis.com/upload/youtube/v3/captions', () => Response.json({ id: 'cap' })],
      ['POST https://www.googleapis.com/upload/youtube/v3/thumbnails/set', () => Response.json({ error: { code: 403, message: 'forbidden' } }, { status: 403 })],
    ],
    calls,
    units,
  );
  const result = await yt.publish({ ...video, captions: [{ lang: 'en', name: 'English', srt: '1\n00:00:00,000 --> 00:00:01,000\nHi\n' }], thumbnail: { bytes: new Uint8Array([1]), mimeType: 'image/jpeg' } });
  assert.equal(result.externalId, 'vid1');
  assert.equal(result.url, 'https://www.youtube.com/shorts/vid1');
  assert.equal(result.privacy, 'private', 'Google kept it private: recorded, not a failure');
  assert.equal(result.extras.length, 1);
  assert.match(result.extras[0]!, /verified channel/);

  const start = calls.find((c) => c.url.includes('uploadType=resumable'))!;
  assert.equal(start.headers.authorization, 'Bearer at');
  assert.equal(start.headers['x-upload-content-length'], '4');
  const meta = JSON.parse(String(start.body)) as { snippet: { categoryId: string; defaultLanguage: string }; status: { privacyStatus: string } };
  assert.deepEqual([meta.snippet.categoryId, meta.snippet.defaultLanguage, meta.status.privacyStatus], ['28', 'en', 'public']);
  const caption = calls.find((c) => c.url.includes('/captions'))!;
  assert.match(String(caption.headers['content-type']), /^multipart\/related; boundary=/);
  assert.match(String(caption.body), /application\/x-subrip/);
  assert.deepEqual(units, ['insert', 'captionsInsert', 'thumbnailsSet']);
  assert.equal(calls.filter((c) => c.url.startsWith('https://oauth2.googleapis.com/token')).length, 1, 'one token for the run');
});

test('the upload session is never started twice: a lost answer fails rather than making a second video', async () => {
  const calls: Call[] = [];
  const yt = youtube([['POST https://www.googleapis.com/upload/youtube/v3/videos', () => Response.json({ error: 'backendError' }, { status: 503 })]], calls);
  await assert.rejects(yt.publish({ ...video, short: false }), (error: unknown) => error instanceof ConnectorError && error.status === 503);
  assert.equal(calls.filter((c) => c.url.includes('uploadType=resumable')).length, 1);
});

test('an expired refresh token says to connect again, and is not retried as temporary', async () => {
  const yt = new YouTube({ clientId: 'c', clientSecret: 's', refreshToken: 'old', fetch: fakeFetch([[TOKEN, () => Response.json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { status: 400 })]], []) });
  await assert.rejects(yt.delete('vid1'), (error: unknown) => error instanceof ConnectorError && error.retryable === false && /connect YouTube again/.test(error.message));
});

test('an edit reads the snippet and changes only the given fields; a gone video is PostGone; a delete of a gone video is done', async () => {
  const calls: Call[] = [];
  const yt = youtube(
    [
      ['GET https://www.googleapis.com/youtube/v3/videos?part=snippet&id=vid1', () => Response.json({ items: [{ id: 'vid1', snippet: { title: 'Old', description: 'Old d', tags: ['a'], categoryId: '28', defaultLanguage: 'es' } }] })],
      ['GET https://www.googleapis.com/youtube/v3/videos?part=snippet&id=gone', () => Response.json({ items: [] })],
      ['PUT https://www.googleapis.com/youtube/v3/videos?part=snippet', () => Response.json({ id: 'vid1' })],
      ['DELETE https://www.googleapis.com/youtube/v3/videos?id=', () => Response.json({ error: { code: 404 } }, { status: 404 })],
    ],
    calls,
  );
  await yt.edit('vid1', { description: 'New d' });
  const put = JSON.parse(String(calls.find((c) => c.method === 'PUT')!.body)) as { id: string; snippet: Record<string, unknown> };
  assert.deepEqual(put, { id: 'vid1', snippet: { title: 'Old', description: 'New d', tags: ['a'], categoryId: '28', defaultLanguage: 'es' } });
  await assert.rejects(yt.edit('gone', { title: 'x' }), PostGone);
  await yt.delete('gone');
});

test('numbers are read 50 videos per call, and a video missing from the answer is left out', async () => {
  const calls: Call[] = [];
  const units: string[] = [];
  const ids = Array.from({ length: 60 }, (_, i) => `v${i}`);
  const yt = youtube(
    [['GET https://www.googleapis.com/youtube/v3/videos?part=statistics', sequence(() => Response.json({ items: ids.slice(0, 49).map((id) => ({ id, statistics: { viewCount: '10', likeCount: '2', commentCount: '1' } })) }), () => Response.json({ items: ids.slice(50).map((id) => ({ id, statistics: { viewCount: '5' } })) }))]],
    calls,
    units,
  );
  const read = await yt.metrics(ids);
  assert.equal(calls.filter((c) => c.url.includes('part=statistics')).length, 2);
  assert.equal(read.size, 59);
  assert.deepEqual(read.get('v0'), { views: 10, likes: 2, comments: 1 });
  assert.deepEqual(read.get('v55'), { views: 5 });
  assert.equal(read.has('v49'), false);
  assert.deepEqual(units, ['list', 'list']);
  assert.equal(YOUTUBE_UNITS.list, 1);
});

test('comments: threads and replies as plain text, the owner’s own marked, disabled comments read as none', async () => {
  const yt = youtube([
    ['GET https://www.googleapis.com/youtube/v3/channels?part=id&mine=true', () => Response.json({ items: [{ id: 'UCme' }] })],
    [
      'GET https://www.googleapis.com/youtube/v3/commentThreads?part=snippet%2Creplies&videoId=vid1',
      () =>
        Response.json({
          items: [
            {
              id: 't1',
              snippet: { topLevelComment: { id: 'c1', snippet: { textOriginal: 'Nice!', authorDisplayName: '@ana', authorChannelId: { value: 'UCana' }, publishedAt: '2026-10-28T10:00:00Z', authorProfileImageUrl: 'javascript:alert(1)' } } },
              replies: { comments: [{ id: 'c1.r1', snippet: { textOriginal: 'Thanks', authorDisplayName: '@me', authorChannelId: { value: 'UCme' }, publishedAt: '2026-10-28T11:00:00Z', parentId: 'c1' } }] },
            },
          ],
        }),
    ],
    ['GET https://www.googleapis.com/youtube/v3/commentThreads?part=snippet%2Creplies&videoId=quiet', () => Response.json({ error: { errors: [{ reason: 'commentsDisabled' }] } }, { status: 403 })],
    ['POST https://www.googleapis.com/youtube/v3/comments?part=snippet', () => Response.json({ id: 'c1.r2' })],
  ]);
  const comments = await yt.comments('vid1');
  assert.deepEqual(
    comments.map((c) => [c.externalId, c.text, c.own, c.inReplyTo ?? null, c.author.avatarUrl ?? null]),
    [
      ['c1', 'Nice!', false, null, null],
      ['c1.r1', 'Thanks', true, 'c1', null],
    ],
  );
  assert.deepEqual(await yt.comments('quiet'), []);
  const sent = await yt.reply({ postExternalId: 'vid1', commentExternalId: 'c1', authorHandle: '@ana' }, 'Thank you!');
  assert.equal(sent.externalId, 'c1.r2');
});

const REPORTS = 'GET https://youtubeanalytics.googleapis.com/v2/reports';

test('analytics: one report per video, lifetime from the launch day, its columns kept under their names', async () => {
  const calls: Call[] = [];
  const units: string[] = [];
  const report = (views: number) => () =>
    Response.json({
      columnHeaders: ['engagedViews', 'estimatedMinutesWatched', 'averageViewDuration', 'averageViewPercentage', 'shares', 'subscribersGained'].map((name) => ({ name })),
      rows: [[views, 42, 37, 61.5, 3, 2]],
    });
  const yt = youtube([[REPORTS, sequence(report(120), report(80))]], calls, units);
  const out = await yt.analytics([{ id: 'v1', since: '2026-10-29' }, { id: 'v2', since: '2026-10-29' }], '2026-11-03');
  assert.deepEqual(out.get('v1'), { engagedViews: 120, watchMinutes: 42, avgViewSeconds: 37, avgViewPercent: 61.5, shares: 3, subscribersGained: 2 });
  assert.equal(out.get('v2')?.engagedViews, 80);
  const first = new URL(calls.find((c) => c.url.startsWith('https://youtubeanalytics'))!.url);
  assert.deepEqual([first.searchParams.get('ids'), first.searchParams.get('startDate'), first.searchParams.get('endDate'), first.searchParams.get('filters')], ['channel==MINE', '2026-10-29', '2026-11-03', 'video==v1']);
  assert.deepEqual(units, [], 'the Analytics API has its own quota: no Data API units');
});

test('analytics: one video YouTube cannot report on is said, and the others are kept', async () => {
  const report = () => Response.json({ columnHeaders: [{ name: 'shares' }], rows: [[4]] });
  const yt = youtube([[REPORTS, sequence(report, () => Response.json({ error: { code: 400, message: 'Invalid filter' } }, { status: 400 }), report)]]);
  const out = await yt.analytics(
    [
      { id: 'v1', since: '2026-10-29' },
      { id: 'bad', since: '2026-10-29' },
      { id: 'v3', since: '2026-10-29' },
    ],
    '2026-11-03',
  );
  assert.deepEqual([...out], [['v1', { shares: 4 }], ['v3', { shares: 4 }]]);
  assert.equal(out.problems?.length, 1);
  assert.match(out.problems![0]!, /^bad: .*400/);
});

test('analytics refused for a token without yt-analytics.readonly: why, as a failure not worth retrying', async () => {
  const yt = youtube([[REPORTS, () => Response.json({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Request had insufficient authentication scopes.', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }, { status: 403 })]]);
  await assert.rejects(yt.analytics([{ id: 'v1', since: '2026-10-29' }], '2026-11-03'), (error: unknown) => error instanceof ConnectorError && error.retryable === false && /yt-analytics\.readonly.*connect YouTube again/.test(error.message));
});

test('the channel as a profile: description as the bio, keywords, country and trailer as links', async () => {
  const yt = youtube([
    [
      'GET https://www.googleapis.com/youtube/v3/channels?part=snippet,brandingSettings',
      () => Response.json({ items: [{ id: 'UC1', snippet: { title: 'José', thumbnails: { default: { url: 'https://yt3.example/a.jpg' } } }, brandingSettings: { channel: { title: 'José', description: 'Dev tools', keywords: 'rust "claude code"', country: 'ES', unsubscribedTrailer: 'tr1' }, image: { bannerExternalUrl: 'https://yt3.example/b' } } }] }),
    ],
  ]);
  assert.deepEqual(await yt.profile(), {
    displayName: 'José',
    bio: 'Dev tools',
    links: [
      { name: 'Keywords', value: 'rust "claude code"' },
      { name: 'Country', value: 'ES' },
      { name: 'Trailer', value: 'https://www.youtube.com/watch?v=tr1' },
    ],
    hasAvatar: true,
    hasBanner: true,
  });
});

test('a channel edit reads brandingSettings and writes it whole, changing only what was given', async () => {
  const calls: Call[] = [];
  const units: string[] = [];
  const yt = youtube(
    [
      ['GET https://www.googleapis.com/youtube/v3/channels?part=snippet,brandingSettings', () => Response.json({ items: [{ id: 'UC1', brandingSettings: { channel: { description: 'old', keywords: 'rust', country: 'ES', defaultLanguage: 'es' }, image: { bannerExternalUrl: 'https://yt3.example/b' } } }] })],
      ['PUT https://www.googleapis.com/youtube/v3/channels?part=brandingSettings', () => Response.json({ id: 'UC1' })],
    ],
    calls,
    units,
  );
  await yt.editProfile({ bio: 'new', links: [{ name: 'Keywords', value: 'rust cli' }, { name: 'Trailer', value: 'https://youtu.be/tr2' }] });
  const sent = JSON.parse(String(calls.find((c) => c.method === 'PUT')!.body)) as { id: string; brandingSettings: { channel: Record<string, string>; image: Record<string, string> } };
  assert.equal(sent.id, 'UC1');
  assert.deepEqual(sent.brandingSettings.channel, { description: 'new', keywords: 'rust cli', country: 'ES', defaultLanguage: 'es', unsubscribedTrailer: 'tr2' }, 'only the settings the proposal names change: the country it leaves out is kept');
  assert.deepEqual(sent.brandingSettings.image, { bannerExternalUrl: 'https://yt3.example/b' }, 'the banner kept: an update deletes what it leaves out');
  assert.deepEqual(units, ['list', 'channelsUpdate']);

  await assert.rejects(yt.editProfile({ displayName: 'x' }), /YouTube Studio only/);
  await assert.rejects(yt.editProfile({ links: [{ name: 'Website', value: 'https://x' }] }), /has no "Website"/);
});
