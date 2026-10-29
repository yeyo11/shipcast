import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Instagram, Threads } from '../src/index.ts';
import { fakeFetch, type Call } from './fake.ts';

/*
 * Instagram's and Threads' insights beyond a post's six counters (docs/stats.md): each Instagram
 * type's own set, a story's while Meta keeps it, the account's in the daily snapshot, and Threads'
 * link clicks per address given to the post that carries it. All over a fake network.
 */

const G = 'https://graph.instagram.com/v25.0';
const T = 'https://graph.threads.com/v1.0';
const metric = (url: string) => new URL(url).searchParams.get('metric');
const insight = (name: string, value: number) => ({ name, total_value: { value } });
const broken = (dimension: string, results: Record<string, number>) => ({
  name: dimension,
  total_value: { value: Object.values(results).reduce((a, b) => a + b, 0), breakdowns: [{ results: Object.entries(results).map(([k, value]) => ({ dimension_values: [k], value })) }] },
});

test('an Instagram carousel reads its feed set, then its profile activity apart, with the bio-link clicks', async () => {
  const calls: Call[] = [];
  const instagram = new Instagram({
    userId: '1784',
    accessToken: 't',
    fetch: fakeFetch(
      [
        [`GET ${G}/m1?fields=media_type`, () => Response.json({ media_type: 'CAROUSEL_ALBUM', id: 'm1' })],
        [
          `GET ${G}/m1/insights`,
          () =>
            metric(calls.at(-1)!.url) === 'profile_activity'
              ? Response.json({ data: [broken('profile_activity', { BIO_LINK_CLICKED: 3, OTHER: 1 })] })
              : Response.json({ data: [insight('views', 400), insight('reach', 150), insight('reposts', 2), insight('follows', 1), insight('profile_visits', 9)] }),
        ],
      ],
      calls,
    ),
  });
  assert.deepEqual(await instagram.metrics('m1'), { views: 400, reach: 150, reposts: 2, follows: 1, profile_visits: 9, profile_activity: 4, bio_link_clicks: 3 });
  const asked = calls.filter((c) => c.url.includes('/insights')).map((c) => metric(c.url));
  assert.deepEqual(asked, ['views,reach,likes,comments,saved,shares,reposts,total_interactions,follows,profile_visits', 'profile_activity']);
  assert.equal(new URL(calls.at(-1)!.url).searchParams.get('breakdown'), 'action_type');
});

test('an Instagram Reel reads its watch time and skip rate, and Facebook views only where Meta has them', async () => {
  const reel = (facebook: () => Response) => {
    const calls: Call[] = [];
    const instagram = new Instagram({
      userId: '1784',
      accessToken: 't',
      fetch: fakeFetch(
        [
          [`GET ${G}/r1?fields=media_type`, () => Response.json({ media_type: 'VIDEO' })],
          [
            `GET ${G}/r1/insights`,
            () =>
              metric(calls.at(-1)!.url) === 'facebook_views'
                ? facebook()
                : Response.json({ data: [insight('views', 900), insight('ig_reels_avg_watch_time', 4200), insight('reels_skip_rate', 35.5)] }),
          ],
        ],
        calls,
      ),
    });
    return { instagram, calls };
  };
  const shared = reel(() => Response.json({ data: [insight('facebook_views', 120)] }));
  assert.deepEqual(await shared.instagram.metrics('r1'), { views: 900, avg_watch_ms: 4200, skip_rate: 35.5, facebook_views: 120 });
  assert.equal(metric(shared.calls.find((c) => c.url.includes('/insights'))!.url), 'views,reach,likes,comments,saved,shares,reposts,total_interactions,ig_reels_avg_watch_time,reels_skip_rate');

  // A Reel not shared to Facebook: Meta refuses the call, and the rest still counts
  const alone = reel(() => Response.json({ error: { message: 'The media is not shared to Facebook', code: 100 } }, { status: 400 }));
  assert.deepEqual(await alone.instagram.metrics('r1'), { views: 900, avg_watch_ms: 4200, skip_rate: 35.5 });
});

/** A cache that keeps every value it is given, with the time it was given for */
function memoryCache() {
  const kept = new Map<string, { value: string; ttl: number }>();
  return {
    kept,
    async remember<V extends string>(key: string, ttl: number, load: () => Promise<V>): Promise<V> {
      const seen = kept.get(key);
      if (seen !== undefined) return seen.value as V;
      const value = await load();
      kept.set(key, { value, ttl });
      return value;
    },
    async delete(key: string) {
      kept.delete(key);
    },
  };
}

test('an Instagram post’s profile activity and a Reel’s Facebook views are read once a day, a refusal included', async () => {
  const calls: Call[] = [];
  const cache = memoryCache();
  const instagram = new Instagram({
    userId: '1784',
    accessToken: 't',
    cache,
    fetch: fakeFetch(
      [
        [`GET ${G}/m1?fields=media_type`, () => Response.json({ media_type: 'IMAGE' })],
        [`GET ${G}/r1?fields=media_type`, () => Response.json({ media_type: 'VIDEO' })],
        [
          `GET ${G}/m1/insights`,
          () => (metric(calls.at(-1)!.url) === 'profile_activity' ? Response.json({ data: [broken('profile_activity', { BIO_LINK_CLICKED: 3 })] }) : Response.json({ data: [insight('views', 40)] })),
        ],
        [
          `GET ${G}/r1/insights`,
          () => (metric(calls.at(-1)!.url) === 'facebook_views' ? Response.json({ error: { message: 'The media is not shared to Facebook', code: 100 } }, { status: 400 }) : Response.json({ data: [insight('views', 90)] })),
        ],
      ],
      calls,
    ),
  });
  for (let hour = 0; hour < 3; hour++) {
    assert.deepEqual(await instagram.metrics('m1'), { views: 40, profile_activity: 3, bio_link_clicks: 3 }, 'the day’s activity is still in every reading');
    assert.deepEqual(await instagram.metrics('r1'), { views: 90 });
  }
  const asked = (name: string) => calls.filter((c) => c.url.includes('/insights') && metric(c.url) === name).length;
  assert.equal(asked('profile_activity'), 1);
  assert.equal(asked('facebook_views'), 1, 'a Reel Meta refuses is not asked again within the day');
  assert.equal(asked('views,reach,likes,comments,saved,shares,reposts,total_interactions,follows,profile_visits'), 3, 'the counters stay hourly');
  assert.ok([...cache.kept].filter(([key]) => !key.startsWith('instagram-media-type:')).every(([, { ttl }]) => ttl <= 86_400), 'kept a day at most');
});

test('an Instagram piece whose type cannot be read gets what every type has; a cache keeps the type', async () => {
  const calls: Call[] = [];
  const kept = new Map<string, string>();
  const cache = {
    async remember<V extends string>(key: string, _ttl: number, load: () => Promise<V>): Promise<V> {
      const seen = kept.get(key) as V | undefined;
      if (seen !== undefined) return seen;
      const value = await load();
      kept.set(key, value);
      return value;
    },
    async delete(key: string) {
      kept.delete(key);
    },
  };
  const instagram = new Instagram({
    userId: '1784',
    accessToken: 't',
    cache,
    fetch: fakeFetch(
      [
        [`GET ${G}/p1?fields=media_type`, () => Response.json({ media_type: 'IMAGE' })],
        [`GET ${G}/x?fields=media_type`, () => new Response('{"error":{"code":100}}', { status: 400 })],
        [`GET ${G}/p1/insights`, () => Response.json({ data: [insight('views', 1)] })],
        [`GET ${G}/x/insights`, () => Response.json({ data: [insight('views', 2)] })],
      ],
      calls,
    ),
  });
  assert.deepEqual(await instagram.metrics('x'), { views: 2 });
  assert.equal(metric(calls.at(-1)!.url), 'views,reach,likes,comments,saved,shares,reposts,total_interactions', 'no profile activity nor Facebook views without a type');
  await instagram.metrics('p1');
  await instagram.metrics('p1');
  assert.equal(calls.filter((c) => c.url.startsWith(`${G}/p1?fields=media_type`)).length, 1, 'the type is read once');
});

test('an Instagram story reads its set and its navigation apart; under five viewers is no numbers, not a failure', async () => {
  const calls: Call[] = [];
  let viewers = 3;
  const instagram = new Instagram({
    userId: '1784',
    accessToken: 't',
    fetch: fakeFetch(
      [
        [
          `GET ${G}/s1/insights`,
          () => {
            if (viewers < 5) return Response.json({ error: { message: '(#10) Not enough viewers for the media to show insights', type: 'OAuthException', code: 10 } }, { status: 400 });
            return metric(calls.at(-1)!.url) === 'navigation'
              ? Response.json({ data: [broken('navigation', { TAP_FORWARD: 20, TAP_BACK: 2, TAP_EXIT: 5 })] })
              : Response.json({ data: [insight('views', 60), insight('reach', 40), insight('shares', 1), insight('profile_visits', 3)] });
          },
        ],
      ],
      calls,
    ),
  });
  assert.deepEqual(await instagram.storyMetrics('s1'), {});
  viewers = 50;
  assert.deepEqual(await instagram.storyMetrics('s1'), { views: 60, reach: 40, shares: 1, profile_visits: 3, taps_forward: 20, taps_back: 2, exits: 5, swipes_forward: 0 });
  assert.deepEqual(
    calls.slice(-2).map((c) => [metric(c.url), new URL(c.url).searchParams.get('breakdown')]),
    [
      ['views,reach,shares,reposts,total_interactions,follows,profile_visits', null],
      ['navigation', 'story_navigation_action_type'],
    ],
  );
  assert.equal(calls.some((c) => c.url.includes('fields=media_type')), false, 'a story needs no type');
});

test('an Instagram story refused for any other reason fails as before', async () => {
  const instagram = new Instagram({ userId: '1784', accessToken: 't', fetch: fakeFetch([[`GET ${G}/s1/insights`, () => new Response('{"error":{"code":190}}', { status: 401 })]], []) });
  await assert.rejects(instagram.storyMetrics('s1'), /401/);
});

test('an Instagram story refused for a missing permission is a failure, though Meta gives it the same #10', async () => {
  // Code 10 is also Graph API's "permission denied": only the message tells it from too few viewers
  const refusal = () => Response.json({ error: { message: '(#10) Application does not have permission for this action', type: 'OAuthException', code: 10 } }, { status: 403 });
  const instagram = new Instagram({ userId: '1784', accessToken: 't', fetch: fakeFetch([[`GET ${G}/s1/insights`, refusal]], []) });
  await assert.rejects(instagram.storyMetrics('s1'), /permission/);
});

test('the Instagram snapshot adds the last day’s account insights, and says what Meta refused', async () => {
  const calls: Call[] = [];
  const followers = { n: 500 };
  const instagram = new Instagram({
    userId: '1784',
    accessToken: 't',
    fetch: fakeFetch(
      [
        [`GET ${G}/me?fields=followers_count`, () => Response.json({ followers_count: followers.n, follows_count: 50, media_count: 33 })],
        [
          `GET ${G}/1784/insights`,
          () =>
            metric(calls.at(-1)!.url) === 'follows_and_unfollows'
              ? new Response('{"error":{"message":"not enough followers"}}', { status: 400 })
              : Response.json({ data: [insight('views', 1200), insight('reach', 300), insight('accounts_engaged', 40), insight('total_interactions', 55), insight('profile_links_taps', 6)] }),
        ],
      ],
      calls,
    ),
  });
  const stats = await instagram.profileStats();
  assert.deepEqual(stats.extra, { views1d: 1200, reach1d: 300, accountsEngaged1d: 40, interactions1d: 55, linkTaps1d: 6 });
  assert.equal(stats.followers, 500);
  assert.match(stats.unread?.[0] ?? '', /^follows and unfollows: /);
  const account = new URL(calls.find((c) => c.url.includes('/1784/insights'))!.url).searchParams;
  assert.equal(account.get('period'), 'day');
  assert.equal(account.get('metric_type'), 'total_value');

  // Under 100 followers the follows are not asked for at all
  followers.n = 40;
  const before = calls.length;
  assert.equal((await instagram.profileStats()).unread, undefined);
  assert.equal(calls.slice(before).filter((c) => metric(c.url) === 'follows_and_unfollows').length, 0);
});

test('the Instagram profile is read: name, bio, website and whether there is a picture', async () => {
  const instagram = new Instagram({
    userId: '1784',
    accessToken: 't',
    fetch: fakeFetch([[`GET ${G}/me?fields=name%2Cbiography%2Cwebsite%2Cprofile_picture_url`, () => Response.json({ name: 'José', biography: 'I build tools', website: 'https://josegarrido.dev', profile_picture_url: 'https://scontent.cdninstagram.com/p.jpg' })]], []),
  });
  assert.deepEqual(await instagram.profile(), { displayName: 'José', bio: 'I build tools', links: [{ name: 'Website', value: 'https://josegarrido.dev' }], hasAvatar: true });
});

test('Threads gives each address’s clicks to the newest post that carries it, and says when the clicks fail', async () => {
  const calls: Call[] = [];
  let clicks: () => Response = () =>
    Response.json({
      data: [
        {
          name: 'clicks',
          link_total_values: [
            { value: 7, link_url: 'https://josegarrido.dev/en/sluice/?ref=threads' },
            { value: 2, link_url: 'https://josegarrido.dev/en/sluice/?utm_source=threads' },
            { value: 4, link_url: 'https://other.example/' },
          ],
        },
      ],
    });
  const threads = new Threads({
    userId: '42',
    accessToken: 't',
    fetch: fakeFetch(
      [
        [`GET ${T}/p1/insights`, () => Response.json({ data: [insight('views', 100)] })],
        [`GET ${T}/p2/insights`, () => Response.json({ data: [insight('views', 30)] })],
        [`GET ${T}/p3/insights`, () => new Response('{"error":{"code":100}}', { status: 400 })],
        [
          `GET ${T}/42/threads?`,
          () =>
            Response.json({
              data: [
                { id: 'p2', text: 'Sluice, a week on https://josegarrido.dev/en/sluice/?ref=threads', timestamp: '2026-10-28T10:00:00+0000' },
                { id: 'other', text: 'not ours', timestamp: '2026-10-27T10:00:00+0000' },
                { id: 'p1', text: 'Sluice is out https://josegarrido.dev/en/sluice/?ref=threads', timestamp: '2026-10-20T10:00:00+0000' },
              ],
            }),
        ],
        [`GET ${T}/42/threads_insights`, () => clicks()],
      ],
      calls,
    ),
  });
  const answer = await threads.metricsMany(['p1', 'p2', 'p3']);
  assert.deepEqual(answer.get('p2'), { views: 30, clicks: 9 }, 'the same address, then the same page, go to the newest post');
  assert.deepEqual(answer.get('p1'), { views: 100, clicks: 0 });
  assert.equal(answer.has('p3'), false);
  assert.match(answer.problems?.[0] ?? '', /^p3: /);
  const asked = new URL(calls.find((c) => c.url.includes('threads_insights'))!.url).searchParams;
  assert.equal(asked.get('metric'), 'clicks');
  assert.equal(Number(asked.get('since')), Date.parse('2026-10-19T10:00:00Z') / 1000, 'from a day before the oldest post');

  clicks = () => new Response('{"error":{"message":"denied"}}', { status: 403 });
  const failed = await threads.metricsMany(['p1']);
  assert.deepEqual(failed.get('p1'), { views: 100 }, 'the post’s own numbers still count');
  assert.match(failed.problems?.[0] ?? '', /^link clicks: /);
});

test('the Threads snapshot adds yesterday’s profile views, and the profile is read without links', async () => {
  const calls: Call[] = [];
  let views: () => Response = () => Response.json({ data: [{ name: 'views', values: [{ value: 12, end_time: '2026-10-28T07:00:00+0000' }] }] });
  const threads = new Threads({
    userId: '42',
    accessToken: 't',
    fetch: fakeFetch(
      [
        [`GET ${T}/42/threads_insights?metric=followers_count`, () => Response.json({ data: [{ name: 'followers_count', total_value: { value: 80 } }] })],
        [`GET ${T}/42/threads_insights?metric=views`, () => views()],
        [`GET ${T}/me?fields=name%2Cthreads_biography%2Cthreads_profile_picture_url`, () => Response.json({ name: 'José', threads_biography: 'Tools', threads_profile_picture_url: 'https://scontent.cdninstagram.com/t.jpg' })],
      ],
      calls,
    ),
  });
  assert.deepEqual(await threads.profileStats(), { followers: 80, extra: { profileViews1d: 12 } });
  const asked = new URL(calls.at(-1)!.url).searchParams;
  assert.equal(Number(asked.get('until')) - Number(asked.get('since')), 86_400);
  assert.equal(Number(asked.get('until')) % 86_400, 0, 'a whole UTC day');

  views = () => new Response('{"error":{"message":"denied"}}', { status: 403 });
  const refused = await threads.profileStats();
  assert.equal(refused.followers, 80);
  assert.match(refused.unread?.[0] ?? '', /^profile views: /);

  assert.deepEqual(await threads.profile(), { displayName: 'José', bio: 'Tools', links: [], hasAvatar: true });
});
