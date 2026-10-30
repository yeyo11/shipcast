import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MediaStoreUnavailable, R2MediaStore, sha256Hex } from '@shipcast/engine';
import { ConfigError, loadMediaStoreConfig } from '../src/config.ts';
import { Flags } from '../src/flags.ts';
import { mediaStoreFor } from '../src/media.ts';

const BUCKET = {
  SHIPCAST_MEDIA_ENDPOINT: 'https://account.r2.cloudflarestorage.com/',
  SHIPCAST_MEDIA_BUCKET: 'shipcast-media',
  SHIPCAST_MEDIA_ACCESS_KEY_ID: 'key-id',
  SHIPCAST_MEDIA_SECRET_ACCESS_KEY: 'secret',
};
const on = new Flags(['launch-media']);

test('with the flag off the store refuses every call, whatever .env says, and reads nothing', async () => {
  const store = mediaStoreFor(new Flags(), { ...BUCKET, SHIPCAST_MEDIA_BUCKET: '' });
  assert.equal(store.storage, 'none');
  await assert.rejects(store.put(new Uint8Array([1]), 'image/png'), (error: unknown) => error instanceof MediaStoreUnavailable && /launch-media flag is off/.test(error.message));
});

test('with the flag on and no bucket in .env the store refuses, naming what is missing', async () => {
  const store = mediaStoreFor(on, {});
  await assert.rejects(
    store.get('media/aa/x'),
    (error: unknown) =>
      error instanceof MediaStoreUnavailable &&
      error.message === 'the media store is not available: missing in .env: SHIPCAST_MEDIA_ENDPOINT, SHIPCAST_MEDIA_BUCKET, SHIPCAST_MEDIA_ACCESS_KEY_ID, SHIPCAST_MEDIA_SECRET_ACCESS_KEY (see .env.example)',
  );
});

test('with the flag on and the bucket in .env it is R2, signed with the key pair', async () => {
  const seen: string[] = [];
  const fetch = (async (input: URL | Request | string, init?: RequestInit) => {
    seen.push(`${init?.method} ${String(input)} ${new Headers(init?.headers).get('authorization')?.split('/')[0]}`);
    return new Response(null, { status: 200 });
  }) as typeof globalThis.fetch;
  const store = mediaStoreFor(on, BUCKET, { fetch });
  assert.ok(store instanceof R2MediaStore);
  const stored = await store.put(new Uint8Array([1, 2]), 'image/png');
  assert.equal(stored.sha256, sha256Hex(new Uint8Array([1, 2])));
  assert.deepEqual(seen, [`PUT https://account.r2.cloudflarestorage.com/shipcast-media/${stored.key} AWS4-HMAC-SHA256 Credential=key-id`]);
});

test('half a bucket in .env stops the start; an endpoint that is not https://host is refused', () => {
  assert.equal(loadMediaStoreConfig({}), undefined);
  assert.throws(() => loadMediaStoreConfig({ SHIPCAST_MEDIA_BUCKET: 'b' }), (error: unknown) => error instanceof ConfigError && /missing SHIPCAST_MEDIA_ENDPOINT, SHIPCAST_MEDIA_ACCESS_KEY_ID, SHIPCAST_MEDIA_SECRET_ACCESS_KEY/.test(error.message));
  assert.throws(() => loadMediaStoreConfig({ ...BUCKET, SHIPCAST_MEDIA_ENDPOINT: 'http://localhost:9000' }), ConfigError);
  assert.throws(() => mediaStoreFor(on, { ...BUCKET, SHIPCAST_MEDIA_ENDPOINT: 'https://x.dev/bucket?key=1' }), ConfigError);
  assert.deepEqual(loadMediaStoreConfig({ ...BUCKET, SHIPCAST_MEDIA_REGION: 'eu-west-1' }), {
    endpoint: 'https://account.r2.cloudflarestorage.com',
    bucket: 'shipcast-media',
    accessKeyId: 'key-id',
    secretAccessKey: 'secret',
    region: 'eu-west-1',
  });
});
