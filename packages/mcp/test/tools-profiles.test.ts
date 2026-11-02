import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptedJob, apiError, fakeClient, refusal, runTool, type FakeRoutes } from './fake-api.ts';

const ROUTES: FakeRoutes = {
  'GET /profile-capabilities': { capabilities: { mastodon: { read: true, edit: 'yes', fields: ['displayName', 'bio', 'links'], editable: ['displayName', 'bio', 'links'] } } },
  'GET /accounts/1/profile-review': { capability: { read: true, edit: 'yes' }, review: null },
  'POST /accounts/1/profile-review': acceptedJob('j7'),
  'POST /accounts/2/profile-review': () => apiError(409, 'refused', 'this network has no profile'),
  'PATCH /accounts/1/profile': { profile: { displayName: 'José', bio: 'Builds things' } },
};

test('the profile tools make their one API call each, in the API\'s names', async () => {
  const { fake, api } = fakeClient(ROUTES);
  await runTool(api, 'list_profile_capabilities', {});
  await runTool(api, 'get_profile_review', { account_id: 1 });
  await runTool(api, 'review_profile', { account_id: 1, pasted: { display_name: 'José', links: 'Site: https://example.com' }, language: 'es' });
  await runTool(api, 'edit_profile', { account_id: 1, display_name: 'José', links: [{ name: 'Site', value: 'https://example.com' }], confirm: true });
  assert.deepEqual(fake.calls, [
    'GET /profile-capabilities',
    'GET /accounts/1/profile-review',
    'POST /accounts/1/profile-review {"pasted":{"displayName":"José","links":"Site: https://example.com"},"language":"es"}',
    'PATCH /accounts/1/profile {"displayName":"José","links":[{"name":"Site","value":"https://example.com"}]}',
  ]);
});

test('review_profile sends no body for a plain review, and says the job changes nothing on the network', async () => {
  const { fake, api } = fakeClient(ROUTES);
  const started = await runTool(api, 'review_profile', { account_id: 1 });
  assert.deepEqual(fake.calls, ['POST /accounts/1/profile-review']);
  assert.match(JSON.stringify(started), /"job":"j7".*nothing changes on its network.*list_jobs/);
  assert.match(await refusal(api, 'review_profile', { account_id: 2 }), /this network has no profile/);
});

test('edit_profile changes nothing without a field and confirm: true', async () => {
  const { fake, api } = fakeClient(ROUTES);
  for (const args of [{ account_id: 1, bio: 'New' }, { account_id: 1, bio: 'New', confirm: false }]) {
    assert.match(await refusal(api, 'edit_profile', args), /Nothing was changed\. Changing the public profile of account 1 cannot be undone.*edit_profile again with confirm: true/);
  }
  assert.match(await refusal(api, 'edit_profile', { account_id: 1, confirm: true }), /at least one field/);
  assert.match(await refusal(api, 'edit_profile', { account_id: 1, links: Array.from({ length: 21 }, () => ({ name: 'a', value: 'b' })), confirm: true }), /Invalid arguments for edit_profile/);
  assert.match(await refusal(api, 'review_profile', { account_id: 1, language: 'spanish' }), /Invalid arguments for review_profile/);
  assert.match(await refusal(api, 'get_profile_review', { account_id: 0 }), /Invalid arguments for get_profile_review/);
  assert.deepEqual(fake.calls, [], 'the API was never called');
});

test('apply_profile_proposal and apply_brand_picture call the API once each with confirm: true', async () => {
  const { fake, api } = fakeClient({
    'POST /accounts/1/profile-review/apply': { profile: { bio: 'Builds things' } },
    'POST /accounts/1/profile/picture': { profile: { hasAvatar: true } },
    'POST /accounts/2/profile/picture': () => apiError(409, 'refused', 'mastodon cannot change the picture through its API'),
  });
  await runTool(api, 'apply_profile_proposal', { account_id: 1, field: 'bio', value: 'Builds things', confirm: true });
  await runTool(api, 'apply_brand_picture', { account_id: 1, confirm: true });
  assert.match(await refusal(api, 'apply_brand_picture', { account_id: 2, confirm: true }), /cannot change the picture/);
  assert.deepEqual(fake.calls, ['POST /accounts/1/profile-review/apply {"field":"bio","value":"Builds things"}', 'POST /accounts/1/profile/picture', 'POST /accounts/2/profile/picture']);
});

test('apply_profile_proposal and apply_brand_picture change nothing without confirm: true or with a field they do not take', async () => {
  const { fake, api } = fakeClient();
  for (const confirm of [undefined, false]) {
    assert.match(
      await refusal(api, 'apply_profile_proposal', { account_id: 1, field: 'bio', value: 'New', ...(confirm !== undefined && { confirm }) }),
      /Nothing was changed\. Changing the bio of account 1's public profile cannot be undone.*apply_profile_proposal again with confirm: true/,
    );
    assert.match(await refusal(api, 'apply_brand_picture', { account_id: 1, ...(confirm !== undefined && { confirm }) }), /Nothing was changed\. Changing the public picture of account 1.*apply_brand_picture again/);
  }
  assert.match(await refusal(api, 'apply_profile_proposal', { account_id: 1, field: 'avatar', value: 'x', confirm: true }), /Invalid arguments for apply_profile_proposal/);
  assert.match(await refusal(api, 'apply_profile_proposal', { account_id: 1, field: 'bio', confirm: true }), /Invalid arguments for apply_profile_proposal/);
  assert.deepEqual(fake.calls, [], 'the API was never called');
});
