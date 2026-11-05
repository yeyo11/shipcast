import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isVariants, oauthAppSettings, oauthSpecOf, oauthSpecsOf, type NetworkSpec, type OAuthSpec, type OAuthVariants, type SettingsValues } from '../src/index.ts';

/*
 * A network that signs in more than one way (Instagram: Instagram Login, Facebook Login for Business
 * or both) picks its spec from Settings; the specs that share an app derive its settings once.
 */

const specOf = (id: string, name: string): OAuthSpec & { label: string } => ({
  label: `${name} Login`,
  app: { id, term: 'app', name },
  authorizeUrl: () => 'https://example.test/authorize',
  exchange: async () => [],
  errorParams: ['error'],
});
const specA = specOf('instagram', 'Instagram');
const specB = specOf('meta', 'Meta');
const specC = specOf('meta', 'Meta');

function fakeNetwork(oauth: OAuthSpec | OAuthVariants, id = 'fake'): NetworkSpec {
  return {
    id,
    auth: 'oauth',
    fields: [],
    permissions: [],
    howTo: '',
    oauth,
    build: () => {
      throw new Error('never built in this test');
    },
  };
}

test('a network with variants signs in with the one its setting names, else the fallback', () => {
  const net = fakeNetwork({ setting: 'instagramLogin', fallback: 'instagram', variants: { instagram: specA, unified: specB } });
  assert.equal(oauthSpecOf(net, { instagramLogin: 'unified' } as SettingsValues)?.spec, specB);
  assert.equal(oauthSpecOf(net, {} as SettingsValues)?.spec, specA);
  assert.equal(oauthSpecOf(net, { instagramLogin: 'nonsense' } as SettingsValues)?.spec, specA);
  assert.equal(oauthSpecOf(net, { instagramLogin: 'unified' } as SettingsValues)?.variant, 'unified');
});

test('a callback finishes the variant its flow started, whatever the setting says now', () => {
  const net = fakeNetwork({ setting: 'instagramLogin', fallback: 'instagram', variants: { instagram: specA, unified: specB } });
  assert.equal(oauthSpecOf(net, { instagramLogin: 'instagram' } as SettingsValues, 'unified')?.spec, specB);
});

test('a network with one sign-in has no variant, and one without any has no spec', () => {
  const net = fakeNetwork(specA);
  assert.deepEqual(oauthSpecOf(net, { instagramLogin: 'unified' } as SettingsValues), { spec: specA, variant: undefined });
  assert.equal(isVariants(specA), false);
  const none: NetworkSpec = { ...net, oauth: undefined };
  assert.equal(oauthSpecOf(none, {} as SettingsValues), undefined);
  assert.deepEqual(oauthSpecsOf(none), []);
});

test('two specs sharing the meta app derive its settings once', () => {
  const instagram = fakeNetwork({ setting: 'instagramLogin', fallback: 'instagram', variants: { instagram: specA, unified: specB } }, 'instagram');
  const facebook = fakeNetwork(specC, 'facebook');
  assert.equal(oauthSpecsOf(instagram).length, 2);
  const derived = oauthAppSettings([instagram, facebook]);
  assert.deepEqual(Object.keys(derived).filter((n) => n.startsWith('meta')).sort(), ['metaAppId', 'metaAppSecret']);
  assert.deepEqual(Object.keys(derived).sort(), ['instagramAppId', 'instagramAppSecret', 'metaAppId', 'metaAppSecret']);
});
