import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptedJob, apiError, fakeClient, refusal, runTool, type FakeRoutes } from './fake-api.ts';

const comment = { id: 5, postId: 12, launchId: 3, channel: 'bluesky', text: 'Does it work offline?', status: 'draft-ready', draft: 'Yes, it does.', canReply: true };
const settings = { replies: { bluesky: 'approval', mastodon: 'approval', devto: 'approval' } };

const ROUTES: FakeRoutes = {
  'GET /comments': { comments: [comment], capabilities: { bluesky: { read: true, reply: true, note: '' } } },
  'POST /comments/check': acceptedJob('j7'),
  'POST /comments/5/draft': acceptedJob('j8'),
  'POST /comments/6/draft': () => apiError(404, 'not_found', 'no such comment'),
  'PATCH /comments/5': ({ body }) => Response.json({ comment: { ...comment, draft: (JSON.parse(body) as { draft: string }).draft } }),
  'PATCH /comments/7': () => apiError(400, 'invalid', 'a Bluesky reply is at most 300 characters'),
  'POST /comments/5/approve': { comment: { ...comment, status: 'sent', sentUrl: 'https://bsky.example/r/1' } },
  'POST /comments/5/dismiss': { comment: { ...comment, status: 'dismissed' } },
  'GET /comment-settings': settings,
  'PUT /comment-settings': ({ body }) => Response.json({ replies: { ...settings.replies, ...(JSON.parse(body) as typeof settings).replies } }),
};

test('the comment tools make their one API call each', async () => {
  const { fake, api } = fakeClient(ROUTES);
  await runTool(api, 'list_comments', {});
  await runTool(api, 'list_comments', { status: 'draft-ready', channel: 'bluesky', launch_id: 3 });
  await runTool(api, 'edit_reply', { comment_id: 5, draft: 'Yes: it caches everything.' });
  await runTool(api, 'approve_reply', { comment_id: 5, confirm: true });
  await runTool(api, 'dismiss_comment', { comment_id: 5 });
  await runTool(api, 'get_comment_settings', {});
  await runTool(api, 'set_comment_settings', { replies: { mastodon: 'off', devto: 'approval' } });
  assert.deepEqual(fake.calls, [
    'GET /comments',
    'GET /comments?status=draft-ready&channel=bluesky&launch=3',
    'PATCH /comments/5 {"draft":"Yes: it caches everything."}',
    'POST /comments/5/approve',
    'POST /comments/5/dismiss',
    'GET /comment-settings',
    'PUT /comment-settings {"replies":{"mastodon":"off","devto":"approval"}}',
  ]);
});

test('check_comments and redraft_reply answer the job, to follow with list_jobs', async () => {
  const { fake, api } = fakeClient(ROUTES);
  assert.match(JSON.stringify(await runTool(api, 'check_comments', {})), /"job":"j7".*list_jobs/);
  assert.match(JSON.stringify(await runTool(api, 'redraft_reply', { comment_id: 5 })), /"job":"j8".*comment 5.*list_jobs/);
  assert.deepEqual(fake.calls, ['POST /comments/check', 'POST /comments/5/draft']);
});

test('approve_reply sends nothing without confirm: true', async () => {
  const { fake, api } = fakeClient(ROUTES);
  for (const args of [{ comment_id: 5 }, { comment_id: 5, confirm: false }]) {
    assert.match(await refusal(api, 'approve_reply', args), /Nothing was changed\. Sending the reply to comment 5 cannot be undone.*approve_reply again with confirm: true/);
  }
  assert.deepEqual(fake.calls, [], 'the API was never called');
});

test('set_comment_settings needs confirm: true to put a channel that sends on auto', async () => {
  const { fake, api } = fakeClient(ROUTES);
  for (const args of [{ replies: { bluesky: 'auto' } }, { replies: { mastodon: 'off', bluesky: 'auto' }, confirm: false }]) {
    assert.match(await refusal(api, 'set_comment_settings', args), /Nothing was changed\. On auto, Shipcast sends .* on bluesky publicly.*set_comment_settings again with confirm: true/);
  }
  assert.deepEqual(fake.calls, [], 'nothing was saved');
  // dev.to cannot send, so its auto is stored as approval and replies to nobody
  await runTool(api, 'set_comment_settings', { replies: { devto: 'auto' } });
  await runTool(api, 'set_comment_settings', { replies: { bluesky: 'auto', mastodon: 'auto' }, confirm: true });
  assert.deepEqual(fake.calls, ['PUT /comment-settings {"replies":{"devto":"auto"}}', 'PUT /comment-settings {"replies":{"bluesky":"auto","mastodon":"auto"}}']);
});

test('the comment tools refuse what the API would, before calling it', async () => {
  const { fake, api } = fakeClient(ROUTES);
  for (const [name, args] of [
    ['list_comments', { status: 'pending' }],
    ['list_comments', { channel: 'telegram' }],
    ['list_comments', { launch_id: 0 }],
    ['edit_reply', { comment_id: 5, draft: '' }],
    ['edit_reply', { comment_id: 5 }],
    ['approve_reply', {}],
    ['dismiss_comment', { comment_id: 'five' }],
    ['set_comment_settings', { replies: { telegram: 'approval' } }],
    ['set_comment_settings', { replies: { bluesky: 'always' } }],
  ] as const) {
    assert.match(await refusal(api, name, args), new RegExp(`Invalid arguments for ${name}`), `${name} ${JSON.stringify(args)}`);
  }
  assert.match(await refusal(api, 'set_comment_settings', { replies: {} }), /at least one channel/);
  assert.deepEqual(fake.calls, [], 'the API was never called');
});

test('the API\'s refusals reach the model in its words', async () => {
  const { api } = fakeClient(ROUTES);
  assert.match(await refusal(api, 'redraft_reply', { comment_id: 6 }), /no such comment/);
  assert.match(await refusal(api, 'edit_reply', { comment_id: 7, draft: 'x'.repeat(400) }), /at most 300 characters/);
});
