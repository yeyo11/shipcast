import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorError, exchangeRedditCode, Reddit, redditAuthorizeUrl } from '../src/index.ts';
import { fakeFetch, sequence, type Call } from './fake.ts';

const TOKEN = 'POST https://www.reddit.com/api/v1/access_token';
const token = () => Response.json({ access_token: 'at', token_type: 'bearer', expires_in: 3600, scope: 'identity submit read' });
const form = (call: Call | undefined) => Object.fromEntries(new URLSearchParams(String(call?.body)));

function reddit(rules: Array<[string, () => Response]>, calls: Call[] = []) {
  return new Reddit({ clientId: 'cid', clientSecret: 'secret', refreshToken: 'rt', username: 'josegarridodev', fetch: fakeFetch([[TOKEN, token], ...rules], calls) });
}

test('Reddit posts a text post with a token refreshed once, its own User-Agent, and answers its name and address', async () => {
  const calls: Call[] = [];
  const r = reddit(
    [['POST https://oauth.reddit.com/api/submit', () => Response.json({ json: { errors: [], data: { url: 'https://www.reddit.com/r/selfhosted/comments/abc/x/', id: 'abc', name: 't3_abc' } } })]],
    calls,
  );
  const first = await r.publish({ subreddit: 'selfhosted', title: 'I built claudio', text: 'What it does.\n\nhttps://josegarrido.dev/en/claudio/?ref=reddit' });
  await r.publish({ subreddit: 'ClaudeAI', title: 'I built claudio', text: 'Same.' });
  assert.deepEqual(first, { externalId: 't3_abc', url: 'https://www.reddit.com/r/selfhosted/comments/abc/x/' });

  const refreshes = calls.filter((c) => c.url.endsWith('/api/v1/access_token'));
  assert.equal(refreshes.length, 1, 'one refresh serves the run');
  assert.deepEqual(form(refreshes[0]), { grant_type: 'refresh_token', refresh_token: 'rt' });
  assert.equal(refreshes[0]?.headers.authorization, `Basic ${Buffer.from('cid:secret').toString('base64')}`);

  const submit = calls.find((c) => c.url.endsWith('/api/submit'));
  assert.equal(submit?.headers.authorization, 'bearer at');
  assert.equal(submit?.headers['user-agent'], 'web:dev.shipcast:1 (by /u/josegarridodev)');
  assert.deepEqual(form(submit), {
    api_type: 'json',
    kind: 'self',
    sr: 'selfhosted',
    title: 'I built claudio',
    text: 'What it does.\n\nhttps://josegarrido.dev/en/claudio/?ref=reddit',
    sendreplies: 'true',
    resubmit: 'true',
  });
});

test('Reddit’s refusals come as a 200 with errors: a rule is final, a rate limit is tried again, an unnamed post is never posted twice', async () => {
  const answer = (body: unknown) => reddit([['POST https://oauth.reddit.com/api/submit', () => Response.json(body)]]);
  await assert.rejects(
    answer({ json: { errors: [['SUBMIT_VALIDATION_FLAIR_REQUIRED', 'Your post must contain post flair.', 'flair']] } }).publish({ subreddit: 'selfhosted', title: 't', text: 'b' }),
    (e: unknown) => e instanceof ConnectorError && !e.retryable && /r\/selfhosted refused the post: Your post must contain post flair\./.test(e.message),
  );
  await assert.rejects(
    answer({ json: { errors: [['RATELIMIT', 'Take a break for 9 minutes.', 'ratelimit']] } }).publish({ subreddit: 'selfhosted', title: 't', text: 'b' }),
    (e: unknown) => e instanceof ConnectorError && e.retryable,
  );
  await assert.rejects(answer({ json: { errors: [], data: {} } }).publish({ subreddit: 'selfhosted', title: 't', text: 'b' }), (e: unknown) => e instanceof ConnectorError && !e.retryable);
});

test('a refresh token Reddit no longer takes asks to connect again, and is not retried', async () => {
  const r = new Reddit({ clientId: 'c', clientSecret: 's', refreshToken: 'old', username: 'me', fetch: fakeFetch([[TOKEN, () => Response.json({ error: 'invalid_grant' })]], []) });
  await assert.rejects(r.publish({ subreddit: 'a1', title: 't', text: 'b' }), (e: unknown) => e instanceof ConnectorError && !e.retryable && /connect the account again/.test(e.message));
});

test('find answers the account’s own post with that title in that subreddit since the attempt, and nothing older', async () => {
  const calls: Call[] = [];
  const since = new Date('2026-10-27T10:00:00Z');
  const at = (iso: string) => Date.parse(iso) / 1000;
  const r = reddit(
    [
      [
        'GET https://oauth.reddit.com/user/josegarridodev/submitted',
        () =>
          Response.json({
            data: {
              children: [
                { data: { name: 't3_new', title: 'I built claudio', subreddit: 'SelfHosted', permalink: '/r/SelfHosted/comments/new/x/', created_utc: at('2026-10-27T10:00:30Z') } },
                { data: { name: 't3_old', title: 'I built claudio', subreddit: 'ClaudeAI', permalink: '/r/ClaudeAI/comments/old/x/', created_utc: at('2026-10-20T10:00:00Z') } },
              ],
            },
          }),
      ],
    ],
    calls,
  );
  assert.deepEqual(await r.find({ subreddit: 'selfhosted', title: 'I built claudio' }, since), { externalId: 't3_new', url: 'https://www.reddit.com/r/SelfHosted/comments/new/x/' });
  assert.equal(await r.find({ subreddit: 'ClaudeAI', title: 'I built claudio' }, since), undefined, 'an older post with the same title is another launch');
  assert.equal(await r.find({ subreddit: 'selfhosted', title: 'Another title' }, since), undefined);
  assert.ok(calls.every((c) => c.method === 'GET' || c.url.endsWith('/access_token')), 'finding never submits');
});

test('Reddit deletes a post by its name, checks the account it belongs to, and counts its followers and karma', async () => {
  const calls: Call[] = [];
  const me = () => Response.json({ name: 'josegarridodev', icon_img: 'https://styles.redditmedia.com/a.png?width=256&amp;s=1', total_karma: 42, subreddit: { subscribers: 7 } });
  const r = reddit(
    [
      ['POST https://oauth.reddit.com/api/del', () => Response.json({})],
      ['GET https://oauth.reddit.com/api/v1/me', sequence(me, me)],
    ],
    calls,
  );
  await r.delete('t3_abc');
  assert.deepEqual(form(calls.find((c) => c.url.endsWith('/api/del'))), { id: 't3_abc' });
  assert.deepEqual(await r.check(), { ok: true, account: 'u/josegarridodev', avatarUrl: 'https://styles.redditmedia.com/a.png?width=256&s=1', displayName: 'u/josegarridodev' });
  assert.deepEqual(await r.profileStats(), { followers: 7, extra: { karma: 42 } });

  const other = new Reddit({ clientId: 'c', clientSecret: 's', refreshToken: 'rt', username: 'someoneelse', fetch: fakeFetch([[TOKEN, token], ['GET https://oauth.reddit.com/api/v1/me', me]], []) });
  const check = await other.check();
  assert.ok(!check.ok && /belongs to u\/josegarridodev/.test(check.problem));
});

test('Reddit’s OAuth asks for a permanent token, and the code becomes the refresh token and the account’s name', async () => {
  const url = new URL(redditAuthorizeUrl('cid', 'https://app.example/auth/reddit/callback', 'st'));
  assert.equal(url.origin + url.pathname, 'https://www.reddit.com/api/v1/authorize');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    client_id: 'cid',
    response_type: 'code',
    state: 'st',
    redirect_uri: 'https://app.example/auth/reddit/callback',
    duration: 'permanent',
    scope: 'identity submit read',
  });

  const calls: Call[] = [];
  const http = fakeFetch(
    [
      [TOKEN, () => Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })],
      ['GET https://oauth.reddit.com/api/v1/me', () => Response.json({ name: 'josegarridodev' })],
    ],
    calls,
  );
  assert.deepEqual(await exchangeRedditCode({ clientId: 'cid', clientSecret: 'secret' }, 'https://app.example/auth/reddit/callback', 'code', http), { username: 'josegarridodev', refreshToken: 'rt' });
  assert.deepEqual(form(calls[0]), { grant_type: 'authorization_code', code: 'code', redirect_uri: 'https://app.example/auth/reddit/callback' });

  const refused = fakeFetch([[TOKEN, () => Response.json({ error: 'invalid_grant' })]], []);
  await assert.rejects(exchangeRedditCode({ clientId: 'c', clientSecret: 's' }, 'https://x/cb', 'bad', refused), /the code was refused \(invalid_grant\)/);
});
