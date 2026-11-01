import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeClient, refusal, runTool } from './fake-api.ts';

test('the post tools make their one API call each', async () => {
  const { fake, api } = fakeClient();
  await runTool(api, 'get_capabilities', {});
  await runTool(api, 'edit_post', { post_id: 12, text: 'Fixed', image_url: 'https://img.example/a.png', confirm: true });
  await runTool(api, 'delete_post', { post_id: 12, confirm: true });
  assert.deepEqual(fake.calls, ['GET /capabilities', 'PATCH /posts/12 {"text":"Fixed","imageUrl":"https://img.example/a.png"}', 'DELETE /posts/12']);
});

test('delete_post and edit_post change nothing without confirm: true, and edit_post needs a valid field', async () => {
  const { fake, api } = fakeClient();
  for (const args of [{ post_id: 12 }, { post_id: 12, confirm: false }]) {
    assert.match(await refusal(api, 'delete_post', args), /Nothing was changed\. Deleting post 12 cannot be undone.*delete_post again with confirm: true/);
  }
  assert.match(await refusal(api, 'edit_post', { post_id: 12, text: 'Fixed' }), /Nothing was changed\. Changing post 12 in public cannot be undone.*edit_post again with confirm: true/);
  assert.match(await refusal(api, 'edit_post', { post_id: 12, confirm: true }), /at least one field/);
  assert.match(await refusal(api, 'edit_post', { post_id: 12, link: 'not a url' }), /Invalid arguments for edit_post/);
  assert.deepEqual(fake.calls, [], 'the API was never called');
});
