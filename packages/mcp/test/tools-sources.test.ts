import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createApiClient } from '../src/index.ts';
import { acceptedJob, apiError, BASE, fakeApi, fakeClient, refusal, runTool, TOKEN, type FakeRoutes } from './fake-api.ts';

// The first bytes of a PNG, with a zero and a 0xff that a text encoding would mangle
const IMAGE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10]);
const SHA = 'a'.repeat(64);
const STORED = { file: { sha256: SHA, mime: 'image/png', bytes: IMAGE.byteLength, width: 1, height: 1 } };


/** A client of the fake that also keeps what each call handed to fetch, so a binary body can be compared byte for byte */
function capturingClient(routes: FakeRoutes = {}) {
  const fake = fakeApi(routes);
  const sent: Array<{ url: string; headers: Headers; body: RequestInit['body'] }> = [];
  const api = createApiClient({
    baseUrl: BASE,
    token: TOKEN,
    fetch: async (url, init) => {
      sent.push({ url, headers: new Headers(init.headers), body: init.body });
      return fake.handle(new Request(url, init));
    },
  });
  return { fake, api, sent };
}

test('the client sends JSON by default, raw bytes with their content type when asked, and no body otherwise', async () => {
  const { api, sent } = capturingClient({ 'POST /media': STORED, 'POST /launches/sources': acceptedJob('j1') });
  await api.call('POST', '/launches/sources', { body: { title: 'x' } });
  await api.call('POST', '/media', { raw: { bytes: IMAGE, contentType: 'application/octet-stream' } });
  await api.call('GET', '/launches');
  const [json, raw, none] = sent;
  assert.equal(json?.headers.get('content-type'), 'application/json');
  assert.equal(json?.body, '{"title":"x"}');
  assert.equal(raw?.headers.get('content-type'), 'application/octet-stream');
  assert.ok(raw?.body instanceof Uint8Array, 'the bytes go to fetch as they are, not as JSON');
  assert.deepEqual([...raw.body], [...IMAGE]);
  assert.equal(none?.headers.get('content-type'), null);
  assert.equal(none?.body, undefined);
});

test('a raw body reaches the server byte for byte through Node\'s fetch', async () => {
  let received: { type: string | undefined; bytes: number[]; auth: string | undefined } | undefined;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    received = { type: req.headers['content-type'], bytes: [...Buffer.concat(chunks)], auth: req.headers.authorization };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(STORED));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const api = createApiClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: TOKEN });
    const answer = await api.call('POST', '/media', { raw: { bytes: IMAGE, contentType: 'image/png' } });
    assert.deepEqual(answer, STORED);
    assert.deepEqual(received, { type: 'image/png', bytes: [...IMAGE], auth: `Bearer ${TOKEN}` });
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test('upload_media decodes the base64, sends the bytes and says how to name the image in a launch', async () => {
  const { api, sent } = capturingClient({ 'POST /media': STORED });
  const base64 = Buffer.from(IMAGE).toString('base64');
  for (const image_base64 of [base64, `data:image/png;base64,${base64}`, `${base64.slice(0, 6)}\n${base64.slice(6)}`]) {
    const answer = (await runTool(api, 'upload_media', { image_base64 })) as typeof STORED & { note: string };
    assert.deepEqual(answer.file, STORED.file);
    assert.match(answer.note, new RegExp(`launch_from_sources as \\{ kind: "media", sha256: "${SHA}" \\}`));
  }
  assert.equal(sent.length, 3);
  for (const call of sent) {
    assert.equal(call.url, `${BASE}/api/v1/media`);
    assert.equal(call.headers.get('content-type'), 'application/octet-stream');
    assert.ok(call.body instanceof Uint8Array);
    assert.deepEqual([...call.body], [...IMAGE]);
  }
});

test('upload_media refuses what is not base64, or is over 20 MiB, before calling the API', async () => {
  const { fake, api } = fakeClient({ 'POST /media': STORED });
  assert.match(await refusal(api, 'upload_media', { image_base64: 'not base64!' }), /Nothing was uploaded: image_base64 is not valid base64/);
  assert.match(await refusal(api, 'upload_media', { image_base64: 'data:image/png;base64,' }), /Nothing was uploaded: image_base64 is empty/);
  const tooLarge = 'A'.repeat(Math.ceil((20 * 1024 * 1024) / 3) * 4 + 4);
  assert.match(await refusal(api, 'upload_media', { image_base64: tooLarge }), /larger than the 20 MiB Shipcast takes/);
  assert.match(await refusal(api, 'upload_media', { image_base64: '' }), /Invalid arguments for upload_media/);
  assert.deepEqual(fake.calls, [], 'the API was never called');
});

test('upload_media passes on the API\'s refusal of a file that is not an image', async () => {
  const { api } = fakeClient({ 'POST /media': () => apiError(409, 'refused', 'the file is not a PNG, JPEG, GIF or WebP image') });
  assert.match(await refusal(api, 'upload_media', { image_base64: 'aGVsbG8=' }), /not a PNG, JPEG, GIF or WebP image \(409 refused\)/);
});

test('a file the API finds too large reads as an argument to fix', async () => {
  const { api } = fakeClient({ 'POST /media': () => apiError(413, 'too_large', 'a file has at most 20971520 bytes') });
  assert.match(await refusal(api, 'upload_media', { image_base64: 'aGVsbG8=' }), /at most 20971520 bytes \(413 invalid_input\)\. Fix the arguments/);
});

test('launch_from_sources sends every kind of source in the API\'s shape and answers the job', async () => {
  const { fake, api } = fakeClient({ 'POST /launches/sources': acceptedJob('j7') });
  const answer = (await runTool(api, 'launch_from_sources', {
    title: 'Shipcast 1.0',
    lang: 'es',
    channels: ['bluesky'],
    sources: [
      { kind: 'text', text: 'Why I built it', title: 'Notes' },
      { kind: 'url', url: 'https://example.com/post' },
      { kind: 'repo', repo: 'yeyo11/shipcast', ref: 'v1.0.0', primary: true },
      { kind: 'repo', repo: 'yeyo11/claudio', primary: false },
      { kind: 'media', sha256: SHA, alt: 'The launch page' },
    ],
  })) as { job: string; note: string };
  assert.equal(answer.job, 'j7');
  assert.match(answer.note, /Launching "Shipcast 1.0" from 5 sources\. It runs as a background job/);
  await runTool(api, 'launch_from_sources', { title: 'Notes', sources: [{ kind: 'text', text: 'Hi' }] });
  assert.deepEqual(fake.calls, [
    'POST /launches/sources {"title":"Shipcast 1.0","lang":"es","channels":["bluesky"],"sources":[{"kind":"text","text":"Why I built it","title":"Notes"},{"kind":"url","url":"https://example.com/post"},{"kind":"repo","repo":"yeyo11/shipcast","ref":"v1.0.0","primary":true},{"kind":"repo","repo":"yeyo11/claudio"},{"kind":"media","sha256":"' +
      SHA +
      '","alt":"The launch page"}]}',
    'POST /launches/sources {"title":"Notes","lang":"en","channels":[],"sources":[{"kind":"text","text":"Hi"}]}',
  ]);
});

test('launch_from_sources checks its sources before calling the API, and passes on a refusal', async () => {
  const { fake, api } = fakeClient({ 'POST /launches/sources': () => apiError(409, 'refused', 'yeyo11/shipcast v1.0.0 was launched already') });
  for (const sources of [[], [{ kind: 'media', sha256: 'abc' }], [{ kind: 'url', url: 'ftp://example.com' }], [{ kind: 'video', url: 'https://example.com' }]]) {
    assert.match(await refusal(api, 'launch_from_sources', { title: 'x', sources }), /Invalid arguments for launch_from_sources/);
  }
  assert.deepEqual(fake.calls, []);
  const refused = await refusal(api, 'launch_from_sources', { title: 'x', sources: [{ kind: 'repo', repo: 'yeyo11/shipcast' }] });
  assert.match(refused, /launched already \(409 refused\)\. Shipcast refused the work/);
});

test('edit_launch_posts sends the shared fields and the channels named', async () => {
  const outcomes = { outcomes: [{ postId: 12, channel: 'mastodon', kind: 'post', ok: true }] };
  const { fake, api } = fakeClient({ 'PATCH /launches/3/posts': outcomes });
  assert.match(await refusal(api, 'edit_launch_posts', { launch_id: 3, text: 'Fixed' }), /Nothing was changed\. Changing every live post of launch 3 in public.*confirm: true/);
  assert.deepEqual(await runTool(api, 'edit_launch_posts', { launch_id: 3, text: 'Fixed', image_url: 'https://img.example/a.png', image_alt: 'A chart', confirm: true }), outcomes);
  await runTool(api, 'edit_launch_posts', { launch_id: 3, channels: ['mastodon', 'bluesky'], link: 'https://example.com', confirm: true });
  assert.match(await refusal(api, 'edit_launch_posts', { launch_id: 3, channels: ['mastodon'], confirm: true }), /at least one field/);
  assert.match(await refusal(api, 'edit_launch_posts', { launch_id: 3, text: 'x', channels: [] }), /Invalid arguments for edit_launch_posts/);
  assert.deepEqual(fake.calls, [
    'PATCH /launches/3/posts {"text":"Fixed","imageUrl":"https://img.example/a.png","imageAlt":"A chart"}',
    'PATCH /launches/3/posts {"link":"https://example.com","channels":["mastodon","bluesky"]}',
  ]);
});

test('delete_launch_posts and delete_launch delete nothing without confirm: true', async () => {
  const { fake, api } = fakeClient();
  for (const extra of [{}, { confirm: false }]) {
    assert.match(await refusal(api, 'delete_launch_posts', { launch_id: 3, ...extra }), /Nothing was changed\. Deleting every post of launch 3 cannot be undone.*delete_launch_posts again with confirm: true/);
    assert.match(await refusal(api, 'delete_launch_posts', { launch_id: 3, channels: ['devto', 'bluesky'], ...extra }), /Deleting the devto, bluesky posts of launch 3 cannot be undone/);
    assert.match(await refusal(api, 'delete_launch', { launch_id: 3, channels: ['blog'], ...extra }), /Nothing was changed\. Deleting launch 3 cannot be undone.*delete_launch again with confirm: true/);
  }
  assert.deepEqual(fake.calls, [], 'the API was never called');
});

test('the launch deletion tools make their one API call each, with the channels as a list', async () => {
  const plan = { mode: 'hidden', refused: null, channels: [{ channel: 'devto', out: 1, remove: 'unpublish' }], articleLinks: 2 };
  const done = { mode: 'hidden', outcomes: [], problems: [] };
  const { fake, api } = fakeClient({ 'DELETE /launches/3/posts': { outcomes: [] }, 'GET /launches/3/deletion': plan, 'DELETE /launches/3': done });
  await runTool(api, 'delete_launch_posts', { launch_id: 3, confirm: true });
  await runTool(api, 'delete_launch_posts', { launch_id: 3, channels: ['devto', 'bluesky'], confirm: true });
  assert.deepEqual(await runTool(api, 'plan_launch_deletion', { launch_id: 3 }), plan);
  assert.deepEqual(await runTool(api, 'delete_launch', { launch_id: 3, confirm: true }), done);
  await runTool(api, 'delete_launch', { launch_id: 3, channels: ['blog', 'devto'], confirm: true });
  assert.deepEqual(fake.calls, ['DELETE /launches/3/posts', 'DELETE /launches/3/posts?channels=devto%2Cbluesky', 'GET /launches/3/deletion', 'DELETE /launches/3', 'DELETE /launches/3?channels=blog%2Cdevto']);
});

