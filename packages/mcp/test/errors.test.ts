import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApiClient, invoke, redact, ShipcastApiError } from '../src/index.ts';
import { BASE, fakeClient, named, READ_ONLY, refusal, TOKEN } from './fake-api.ts';

test('API errors become messages that say what to do next', async () => {
  const { api } = fakeClient();
  assert.match(await refusal(api, 'get_launch', { launch_id: 99 }), /no such launch \(404 not_found\)\. .*list_launches/);
  assert.match(await refusal(api, 'launch_repo', { repo: 'yeyo11/old' }), /launched already \(409 refused\)\. .*Do not retry/);
  assert.match(await refusal(api, 'edit_post', { post_id: 13, text: 'x', confirm: true }), /Text is too long \(502 upstream\)/);
  assert.match(await refusal(fakeClient({}, READ_ONLY).api, 'launch_repo', { repo: 'yeyo11/claudio' }), /lacks the write scope \(403 insufficient_scope\)\. .*read,write/);
  assert.match(await refusal(fakeClient({}, 'shipcast_1_wrong').api, 'list_jobs', {}), /\(401 unauthorized\)\. .*token create/);

  const limited = await api.call('GET', '/slow').catch((e: unknown) => e);
  assert.ok(limited instanceof ShipcastApiError);
  assert.equal(limited.retryAfter, 120);
});

test('failures that never reach the API, and the token never shows in a message', async () => {
  const down = createApiClient({ baseUrl: BASE, token: TOKEN, fetch: async () => { throw new Error(`connect ECONNREFUSED (sent ${TOKEN})`); } });
  const outcome = await invoke(named('list_jobs'), down, {});
  assert.match(outcome.ok ? '' : outcome.message, /could not reach Shipcast at https:\/\/shipcast\.example.*\(unreachable\)\. Check SHIPCAST_API_URL/);
  assert.ok(!(outcome.ok ? '' : outcome.message).includes(TOKEN));

  const html = createApiClient({ baseUrl: BASE, token: TOKEN, fetch: async () => new Response('<html>', { status: 200 }) });
  const bad = await invoke(named('list_jobs'), html, {});
  assert.match(bad.ok ? '' : bad.message, /without JSON.*\(200 bad_response\)/);

  const { api } = fakeClient();
  const echoed = await api.call('GET', '/echo-token').catch((e: unknown) => e);
  assert.ok(echoed instanceof ShipcastApiError);
  assert.equal(echoed.message, 'the header was Bearer [token]');
  assert.equal(redact('a b a', 'a'), '[token] b [token]');
});
