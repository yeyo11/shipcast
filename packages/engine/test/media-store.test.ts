import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MediaKeyInvalid, mediaKey, MediaStoreFailed, MediaStoreUnavailable, R2MediaStore, sha256Hex, signS3Request, unavailableMediaStore, type MediaStore } from '../src/index.ts';
import { MemoryMediaStore } from '../src/testing/index.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

test("Signature Version 4 signs a request as AWS's own S3 example does", () => {
  // The GET Object example of AWS's "Authenticating Requests: Using the Authorization Header" for S3
  const headers = signS3Request({
    method: 'GET',
    url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
    headers: { Range: 'bytes=0-9' },
    payloadHash: sha256Hex(''),
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(
    headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
  assert.equal(headers['x-amz-date'], '20130524T000000Z');
});

/** A bucket behind the S3 API, in memory: what R2 answers, checked for a signature on every call */
function fakeBucket() {
  const objects = new Map<string, { body: Uint8Array; type: string }>();
  const calls: string[] = [];
  const fetch = (async (input: URL | Request | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push(`${method} ${url.pathname}`);
    if (!headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256 Credential=key-id/')) return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
    const key = url.pathname.replace(/^\/shipcast-media\//, '');
    if (method === 'PUT') {
      const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
      if (sha256Hex(body) !== headers.get('x-amz-content-sha256')) return new Response('<Error><Code>XAmzContentSHA256Mismatch</Code></Error>', { status: 400 });
      objects.set(key, { body, type: headers.get('content-type') ?? '' });
      return new Response(null, { status: 200 });
    }
    const found = objects.get(key);
    if (method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (!found) return new Response(method === 'HEAD' ? null : '<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    return new Response(method === 'HEAD' ? null : found.body, { status: 200, headers: { 'content-type': found.type } });
  }) as typeof globalThis.fetch;
  return { objects, calls, fetch };
}

const r2 = (fetch: typeof globalThis.fetch) =>
  new R2MediaStore({ endpoint: 'https://account.r2.cloudflarestorage.com/', bucket: 'shipcast-media', accessKeyId: 'key-id', secretAccessKey: 'secret' }, { fetch });

// The same contract for every implementation of the port: the fake tests rely on must behave as R2 does
for (const [name, make] of [
  ['the in-memory fake', () => new MemoryMediaStore()],
  ['R2', () => r2(fakeBucket().fetch)],
] as Array<[string, () => MediaStore]>) {
  test(`${name}: a file is kept under its sha256, read back, found and removed`, async () => {
    const store = make();
    const stored = await store.put(PNG, 'image/png');
    assert.equal(stored.sha256, sha256Hex(PNG));
    assert.equal(stored.key, `media/${stored.sha256.slice(0, 2)}/${stored.sha256}`);
    assert.deepEqual(stored, { key: stored.key, sha256: stored.sha256, bytes: PNG.byteLength, mime: 'image/png' });
    assert.deepEqual(await store.put(PNG, 'image/png'), stored, 'the same bytes again are the same file');
    assert.deepEqual(await store.get(stored.key), { body: PNG, mime: 'image/png' });
    assert.equal(await store.has(stored.key), true);
    await store.delete(stored.key);
    assert.equal(await store.has(stored.key), false);
    assert.equal(await store.get(stored.key), undefined);
    await store.delete(stored.key);
  });

  test(`${name}: refuses a key it did not make, so no other object of the bucket can be reached`, async () => {
    const store = make();
    for (const key of ['../secrets', 'media/aa/../../x', `media/bb/${'a'.repeat(64)}`, 'brand.yml']) {
      await assert.rejects(store.get(key), MediaKeyInvalid);
      await assert.rejects(store.delete(key), MediaKeyInvalid);
    }
  });
}

test('R2 is called on the bucket path with the content type, and a refusal names only the S3 code', async () => {
  const bucket = fakeBucket();
  const stored = await r2(bucket.fetch).put(PNG, 'image/png');
  assert.deepEqual(bucket.calls, [`PUT /shipcast-media/${stored.key}`]);
  assert.equal(bucket.objects.get(stored.key)?.type, 'image/png');

  const denied = new R2MediaStore({ endpoint: 'https://account.r2.cloudflarestorage.com', bucket: 'shipcast-media', accessKeyId: 'other', secretAccessKey: 'x' }, { fetch: bucket.fetch });
  await assert.rejects(denied.get(stored.key), (error: unknown) => error instanceof MediaStoreFailed && error.message === `media store: GET ${stored.key} answered 403 AccessDenied` && !error.retryable);

  const down = new R2MediaStore({ endpoint: 'https://account.r2.cloudflarestorage.com', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' }, { fetch: (async () => new Response('', { status: 503 })) as typeof fetch });
  await assert.rejects(down.has(mediaKey(sha256Hex(PNG))), (error: unknown) => error instanceof MediaStoreFailed && error.retryable);
  const unreachable = new R2MediaStore({ endpoint: 'https://account.r2.cloudflarestorage.com', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' }, { fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
  await assert.rejects(unreachable.put(PNG, 'image/png'), (error: unknown) => error instanceof MediaStoreFailed && error.retryable && !error.message.includes('account.r2') && /did not reach account\.r2\.cloudflarestorage\.com/.test(String((error.cause as Error | undefined)?.message)),
    'the endpoint (it names the account) is only in the cause, for the log');
});

test('a store that is not set up refuses every call with its reason, never retried', async () => {
  const store = unavailableMediaStore('missing in .env: SHIPCAST_MEDIA_BUCKET');
  for (const call of [() => store.put(PNG, 'image/png'), () => store.get('k'), () => store.has('k'), () => store.delete('k')]) {
    await assert.rejects(call(), (error: unknown) => error instanceof MediaStoreUnavailable && !error.retryable && error.message === 'the media store is not available: missing in .env: SHIPCAST_MEDIA_BUCKET');
  }
});
