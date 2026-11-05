import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FACEBOOK_PAGE_METRICS, FACEBOOK_POST_METRICS, FacebookPage } from '../src/index.ts';
import { fakeFetch, type Call } from './fake.ts';

/*
 * A Facebook Page through the Graph API with a Page access token: its link posts, their insights and
 * comments, and the Page's own numbers. All over a fake network.
 */

const G = 'https://graph.facebook.com/v27.0';
const PAGE = '104857600123456';
const POST = `${PAGE}_987654321098765`;
const form = (call: Call | undefined) => new URLSearchParams(String(call?.body));
const metric = (url: string) => new URL(url).searchParams.get('metric');
const lifetime = (name: string, value: number | Record<string, number>) => ({ name, period: 'lifetime', values: [{ value }] });
const named = (names: string) => Response.json({ error: { message: `(#100) The Page post insights endpoint does not support the metrics: ${names}`, type: 'OAuthException', code: 100 } }, { status: 400 });
const unnamed = () => Response.json({ error: { message: '(#100) The value must be a valid insights metric', type: 'OAuthException', code: 100 } }, { status: 400 });

function page(rules: Array<[string, () => Response]>, calls: Call[], pageId = PAGE) {
  return new FacebookPage({ pageId, accessToken: 'page-token', fetch: fakeFetch(rules, calls) });
}

test('a Facebook post sends the text and the link to the Page feed, not the image, and returns its permalink', async () => {
  const calls: Call[] = [];
  const facebook = page(
    [
      [`POST ${G}/${PAGE}/feed`, () => Response.json({ id: POST })],
      [`GET ${G}/${POST}?fields=permalink_url`, () => Response.json({ permalink_url: 'https://www.facebook.com/104857600123456/posts/987654321098765', id: POST })],
    ],
    calls,
  );
  const published = await facebook.publish({ text: 'Shipcast 1.0 is out', link: 'https://example.dev/blog/shipcast', imageUrl: 'https://example.dev/card.png' });
  assert.deepEqual(published, { externalId: POST, url: 'https://www.facebook.com/104857600123456/posts/987654321098765' });
  const body = form(calls[0]);
  assert.equal(body.get('message'), 'Shipcast 1.0 is out');
  assert.equal(body.get('link'), 'https://example.dev/blog/shipcast');
  assert.equal(body.get('access_token'), 'page-token');
  assert.ok(![...body.keys()].some((k) => /image|picture|url/.test(k)), 'the card comes from the article itself');
});

test('a Facebook post whose answer has no id as text fails, named for Facebook', async () => {
  const facebook = page([[`POST ${G}/${PAGE}/feed`, () => Response.json({ id: 42 })]], []);
  await assert.rejects(facebook.publish({ text: 'x', link: 'https://example.dev', imageUrl: 'https://example.dev/c.png' }), /Facebook: .*no id/);
});

test('a Facebook post is edited in place and deleted', async () => {
  const calls: Call[] = [];
  const facebook = page(
    [
      [`POST ${G}/${POST}`, () => Response.json({ success: true })],
      [`DELETE ${G}/${POST}`, () => Response.json({ success: true })],
    ],
    calls,
  );
  await facebook.edit(POST, { text: 'Shipcast 1.0, edited' });
  await facebook.delete(POST);
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(form(calls[0]).get('message'), 'Shipcast 1.0, edited');
  assert.equal(calls[1]?.method, 'DELETE');
  assert.equal(new URL(calls[1]!.url).searchParams.get('access_token'), 'page-token');
});

test('a Facebook post’s numbers: views, clicks and summed reactions from insights, comments and shares from the post', async () => {
  const calls: Call[] = [];
  const facebook = page(
    [
      [
        `GET ${G}/${POST}/insights`,
        () => Response.json({ data: [lifetime('post_impressions_unique', 320), lifetime('post_clicks', 14), lifetime('post_reactions_by_type_total', { like: 6, love: 2, wow: 1 })] }),
      ],
      [`GET ${G}/${POST}?`, () => Response.json({ id: POST, comments: { data: [], summary: { total_count: 4 } }, shares: { count: 3 }, reactions: { data: [], summary: { total_count: 9 } } })],
    ],
    calls,
  );
  assert.deepEqual(await facebook.metrics(POST), { views: 320, clicks: 14, reactions: 9, comments: 4, shares: 3 });
  assert.equal(metric(calls.find((c) => c.url.includes('/insights'))!.url), FACEBOOK_POST_METRICS.join(','));
  const node = new URL(calls.find((c) => !c.url.includes('/insights'))!.url);
  assert.equal(node.searchParams.get('fields'), 'comments.summary(true).limit(0),shares,reactions.summary(true).limit(0)');
});

test('a Facebook metric Meta refuses by name is asked once, then left out, and the post’s reactions stand in', async () => {
  const calls: Call[] = [];
  const facebook = page(
    [
      [
        `GET ${G}/`,
        () => {
          const url = calls.at(-1)!.url;
          if (!url.includes('/insights')) return Response.json({ comments: { summary: { total_count: 1 } }, reactions: { summary: { total_count: 5 } } });
          const asked = metric(url) ?? '';
          return asked.includes('post_reactions_by_type_total') ? named('post_reactions_by_type_total') : Response.json({ data: [lifetime('post_impressions_unique', 50), lifetime('post_clicks', 2)] });
        },
      ],
    ],
    calls,
    'page-refusing-by-name',
  );
  assert.deepEqual(await facebook.metrics('p1'), { views: 50, clicks: 2, reactions: 5, comments: 1, shares: 0 });
  assert.deepEqual(await facebook.metrics('p2'), { views: 50, clicks: 2, reactions: 5, comments: 1, shares: 0 });
  const sets = calls.filter((c) => c.url.includes('/insights')).map((c) => metric(c.url));
  assert.deepEqual(sets, ['post_impressions_unique,post_clicks,post_reactions_by_type_total', 'post_impressions_unique,post_clicks', 'post_impressions_unique,post_clicks']);
});

test('a Facebook set refused without a name is asked metric by metric once, and the refused ones are left out from then on', async () => {
  const calls: Call[] = [];
  const facebook = page(
    [
      [
        `GET ${G}/`,
        () => {
          const url = calls.at(-1)!.url;
          if (!url.includes('/insights')) return Response.json({ shares: { count: 2 }, reactions: { summary: { total_count: 7 } } });
          const asked = (metric(url) ?? '').split(',');
          if (asked.includes('post_clicks')) return unnamed();
          return Response.json({ data: asked.map((name) => (name === 'post_impressions_unique' ? lifetime(name, 80) : lifetime(name, { like: 3, haha: 1 }))) });
        },
      ],
    ],
    calls,
    'page-refusing-unnamed',
  );
  assert.deepEqual(await facebook.metrics('p1'), { views: 80, reactions: 4, comments: 0, shares: 2 });
  assert.deepEqual(await facebook.metrics('p2'), { views: 80, reactions: 4, comments: 0, shares: 2 });
  const sets = calls.filter((c) => c.url.includes('/insights')).map((c) => metric(c.url));
  assert.deepEqual(sets, [
    'post_impressions_unique,post_clicks,post_reactions_by_type_total',
    'post_impressions_unique',
    'post_clicks',
    'post_reactions_by_type_total',
    'post_impressions_unique,post_reactions_by_type_total',
  ]);
});

test('a Facebook set whose every metric is refused, or refused for another reason, still fails', async () => {
  const everything = page([[`GET ${G}/p1/insights`, unnamed]], [], 'page-refusing-all');
  await assert.rejects(everything.metrics('p1'), /valid insights metric/);
  const other = page([[`GET ${G}/p1/insights`, () => Response.json({ error: { message: '(#10) Requires read_insights', code: 10 } }, { status: 403 })]], [], 'page-without-insights');
  await assert.rejects(other.metrics('p1'), /read_insights/);
});

test('Facebook comments map the author’s name, mark the Page’s own, and follow the pages', async () => {
  const calls: Call[] = [];
  const next = `${G}/${POST}/comments?after=QVFI&access_token=page-token`;
  const facebook = page(
    [
      [
        `GET ${G}/${POST}/comments?after=`,
        () => Response.json({ data: [{ id: 'c3', message: 'Thanks!', created_time: '2026-11-05T10:02:00+0000', from: { id: PAGE, name: 'José’s Page' } }] }),
      ],
      [
        `GET ${G}/${POST}/comments`,
        () =>
          Response.json({
            data: [
              { id: 'c1', message: 'Nice launch', created_time: '2026-11-05T10:00:00+0000', from: { id: '5550001', name: 'Ana López' } },
              { id: 'c2', created_time: '2026-11-05T10:01:00+0000' },
            ],
            paging: { cursors: { after: 'QVFI' }, next },
          }),
      ],
    ],
    calls,
  );
  const comments = await facebook.comments(POST);
  assert.deepEqual(comments, [
    { externalId: 'c1', author: { handle: 'Ana López', displayName: 'Ana López' }, text: 'Nice launch', createdAt: '2026-11-05T10:00:00+0000', own: false },
    { externalId: 'c2', author: { handle: 'unknown' }, text: '', createdAt: '2026-11-05T10:01:00+0000', own: false },
    { externalId: 'c3', author: { handle: 'José’s Page', displayName: 'José’s Page' }, text: 'Thanks!', createdAt: '2026-11-05T10:02:00+0000', own: true },
  ]);
  const first = new URL(calls[0]!.url).searchParams;
  assert.equal(first.get('fields'), 'id,message,created_time,from');
  assert.equal(first.get('filter'), 'stream');
  assert.equal(first.get('limit'), '100');
  assert.equal(calls[1]?.url, next);
});

test('a Facebook reply is a comment under the comment', async () => {
  const calls: Call[] = [];
  const facebook = page([[`POST ${G}/c1/comments`, () => Response.json({ id: 'c1_r1' })]], calls);
  assert.deepEqual(await facebook.reply({ postExternalId: POST, commentExternalId: 'c1', authorHandle: 'Ana López' }, 'Thank you, Ana'), { externalId: 'c1_r1' });
  assert.equal(form(calls[0]).get('message'), 'Thank you, Ana');
});

test('a Facebook check: the Page’s name and picture, and another Page’s token is not ok', async () => {
  const answer = { id: PAGE, name: 'José’s Page', picture: { data: { url: 'https://scontent.example/p.jpg' } } };
  const calls: Call[] = [];
  const facebook = page([[`GET ${G}/${PAGE}`, () => Response.json(answer)]], calls);
  assert.deepEqual(await facebook.check(), { ok: true, account: 'José’s Page', avatarUrl: 'https://scontent.example/p.jpg', displayName: 'José’s Page' });
  assert.equal(new URL(calls[0]!.url).searchParams.get('fields'), 'id,name,picture{url}');
  answer.id = '200000000000001';
  assert.deepEqual(await facebook.check(), { ok: false, problem: `the token belongs to the Page José’s Page, not to the Page ${PAGE}` });
  const revoked = page([[`GET ${G}/${PAGE}`, () => Response.json({ error: { message: 'Error validating access token', code: 190 } }, { status: 401 })]], []);
  assert.equal((await revoked.check()).ok, false);
});

test('a Facebook Page’s stats: followers, likes, and the last day’s follows and engagements; a refused insight is said', async () => {
  const calls: Call[] = [];
  const day = (name: string, values: number[]) => ({ name, period: 'day', values: values.map((value) => ({ value })) });
  const facebook = page(
    [
      [`GET ${G}/${PAGE}/insights`, () => Response.json({ data: [day('page_follows', [3, 5]), day('page_post_engagements', [10, 12])] })],
      [`GET ${G}/${PAGE}?`, () => Response.json({ followers_count: 1200, fan_count: 1100, id: PAGE })],
    ],
    calls,
  );
  assert.deepEqual(await facebook.profileStats(), { followers: 1200, extra: { likes: 1100, follows1d: 5, engagements1d: 12 } });
  const insights = new URL(calls.find((c) => c.url.includes('/insights'))!.url).searchParams;
  assert.equal(insights.get('metric'), FACEBOOK_PAGE_METRICS.join(','));
  assert.equal(insights.get('period'), 'day');

  const refusing = page(
    [
      [`GET ${G}/${PAGE}/insights`, () => Response.json({ error: { message: '(#10) Requires read_insights', code: 10 } }, { status: 403 })],
      [`GET ${G}/${PAGE}?`, () => Response.json({ followers_count: 1200, fan_count: 1100 })],
    ],
    [],
  );
  const stats = await refusing.profileStats();
  assert.equal(stats.followers, 1200);
  assert.deepEqual(stats.extra, { likes: 1100 });
  assert.match(stats.unread?.[0] ?? '', /read_insights/);

  const other = '300000000000003';
  const partly = page(
    [
      [`GET ${G}/${other}/insights`, () => (metric(calls.at(-1)?.url ?? '')?.includes('page_follows') ? unnamed() : Response.json({ data: [day('page_post_engagements', [8])] }))],
      [`GET ${G}/${other}?`, () => Response.json({ followers_count: 40 })],
    ],
    calls,
    other,
  );
  assert.deepEqual(await partly.profileStats(), { followers: 40, extra: { engagements1d: 8 }, unread: ['Page insights: Meta refuses page_follows'] });
});

test('a Facebook Page’s profile: the About text as its bio and its picture', async () => {
  const calls: Call[] = [];
  const facebook = page([[`GET ${G}/${PAGE}`, () => Response.json({ about: 'Tools for shipping side projects', picture: { data: { url: 'https://scontent.example/p.jpg' } } })]], calls);
  assert.deepEqual(await facebook.profile(), { bio: 'Tools for shipping side projects', links: [], hasAvatar: true });
  assert.equal(new URL(calls[0]!.url).searchParams.get('fields'), 'about,picture{url}');
  const bare = page([[`GET ${G}/${PAGE}`, () => Response.json({})]], []);
  assert.deepEqual(await bare.profile(), { links: [], hasAvatar: false });
});
