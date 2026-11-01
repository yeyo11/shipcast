import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MediaStoreUnavailable, R2MediaStore, sha256Hex } from '@shipcast/engine';
import { ConfigError, loadMediaStoreConfig } from '../src/config.ts';
import { mediaStoreFor } from '../src/media.ts';

const BUCKET = {
  SHIPCAST_MEDIA_ENDPOINT: 'https://account.r2.cloudflarestorage.com/',
  SHIPCAST_MEDIA_BUCKET: 'shipcast-media',
  SHIPCAST_MEDIA_ACCESS_KEY_ID: 'key-id',
  SHIPCAST_MEDIA_SECRET_ACCESS_KEY: 'secret',
};

test('off a server, with no bucket in .env, the store refuses every call, naming what is missing', async () => {
  for (const env of [{}, { SHIPCAST_APP_TLS: 'off' }, { SHIPCAST_APP_TLS: 'proxy', SHIPCAST_PREVIEW_FAKE_NETWORKS: '1', SHIPCAST_DATABASE_URL: 'postgres://u@h/shipcast_preview' }]) {
    const store = mediaStoreFor(env);
    assert.equal(store.storage, 'none');
    await assert.rejects(
      store.get('media/aa/x'),
      (error: unknown) =>
        error instanceof MediaStoreUnavailable &&
        error.message === 'the media store is not available: missing in .env: SHIPCAST_MEDIA_ENDPOINT, SHIPCAST_MEDIA_BUCKET, SHIPCAST_MEDIA_ACCESS_KEY_ID, SHIPCAST_MEDIA_SECRET_ACCESS_KEY (see .env.example)',
    );
  }
});

test('a server (behind its proxy, not a preview) does not start without the bucket', () => {
  assert.throws(() => mediaStoreFor({ SHIPCAST_APP_TLS: 'proxy' }), (error: unknown) => error instanceof ConfigError && /required on a server: missing in \.env: SHIPCAST_MEDIA_ENDPOINT/.test(error.message));
  assert.ok(mediaStoreFor({ SHIPCAST_APP_TLS: 'proxy', ...BUCKET }) instanceof R2MediaStore);
});

test('with the bucket in .env it is R2, signed with the key pair', async () => {
  const seen: string[] = [];
  const fetch = (async (input: URL | Request | string, init?: RequestInit) => {
    seen.push(`${init?.method} ${String(input)} ${new Headers(init?.headers).get('authorization')?.split('/')[0]}`);
    return new Response(null, { status: 200 });
  }) as typeof globalThis.fetch;
  const store = mediaStoreFor(BUCKET, { fetch });
  assert.ok(store instanceof R2MediaStore);
  const stored = await store.put(new Uint8Array([1, 2]), 'image/png');
  assert.equal(stored.sha256, sha256Hex(new Uint8Array([1, 2])));
  assert.deepEqual(seen, [`PUT https://account.r2.cloudflarestorage.com/shipcast-media/${stored.key} AWS4-HMAC-SHA256 Credential=key-id`]);
});

test('half a bucket in .env stops the start; an endpoint that is not https://host is refused', () => {
  assert.equal(loadMediaStoreConfig({}), undefined);
  assert.throws(() => loadMediaStoreConfig({ SHIPCAST_MEDIA_BUCKET: 'b' }), (error: unknown) => error instanceof ConfigError && /missing SHIPCAST_MEDIA_ENDPOINT, SHIPCAST_MEDIA_ACCESS_KEY_ID, SHIPCAST_MEDIA_SECRET_ACCESS_KEY/.test(error.message));
  assert.throws(() => loadMediaStoreConfig({ ...BUCKET, SHIPCAST_MEDIA_ENDPOINT: 'http://localhost:9000' }), ConfigError);
  assert.throws(() => mediaStoreFor({ ...BUCKET, SHIPCAST_MEDIA_ENDPOINT: 'https://x.dev/bucket?key=1' }), ConfigError);
  assert.deepEqual(loadMediaStoreConfig({ ...BUCKET, SHIPCAST_MEDIA_REGION: 'eu-west-1' }), {
    endpoint: 'https://account.r2.cloudflarestorage.com',
    bucket: 'shipcast-media',
    accessKeyId: 'key-id',
    secretAccessKey: 'secret',
    region: 'eu-west-1',
  });
});
