import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explain } from '../src/components/errors.ts';

test('the errors seen in real use become sentences a person can act on', () => {
  const refused = explain('Instagram: get a long-lived token: 400 {"error":{"message":"Unsupported request - method type: get","type":"IGApiException","code":100}}');
  assert.equal(refused.title, 'Instagram refused this account');
  assert.match(refused.text, /professional/);
  assert.match(refused.details ?? '', /IGApiException/, 'the original stays as details');

  assert.match(explain('the token belongs to @trendify__media, not to the account 29290907873858696').text, /@trendify__media/);
  assert.equal(explain('Mastodon rejected the credential: it is wrong, revoked or expired').title, 'Mastodon refused the credential');
  assert.equal(explain('Solicitud no válida: Invalid redirect_uri').title, 'Meta does not know this address');
  assert.equal(explain('could not reach the network: fetch failed').title, 'The network did not answer');
});

test('an API failure nobody foresaw still says who, what and how, with the details', () => {
  const e = explain('Brevo: create the campaign: 402 {"code":"not_enough_credits"}');
  assert.equal(e.title, 'Brevo said no');
  assert.match(e.text, /answered 402 when Shipcast tried to create the campaign/);
  assert.ok(e.details);
});

test('a short plain sentence is kept as it is', () => {
  assert.deepEqual(explain('no such launch'), { title: 'Something went wrong', text: 'No such launch' });
});
