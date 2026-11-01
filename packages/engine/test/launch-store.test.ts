import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftFile } from '@shipcast/schema';
import { storedFile } from '../src/index.ts';

/*
 * How a file of the drafts maps to the launch model's rows (docs/launch-store.md), which a launch
 * Shipcast holds is written by and the import reads the old pull requests by. The shadow write beside
 * the drafts pull request, and its check, went with the pull-request path (launch-model phase 8).
 */

const LAUNCHES = 'yeyo11/launches';
const D = 'launches/claudio/v1.0.0';
const BLUESKY = `${D}/${draftFile('bluesky').name}`;
const REDDIT = `${D}/${draftFile('reddit', 'selfhosted').name}`;
const ARTICLE = 'src/content/posts/en/claudio.md';

test('the drafts are mapped by path: articles and channel drafts are drafts, pack.json a pack, public/ media, projects.yml the site', () => {
  const launch = { repo: 'yeyo11/claudio', ref: 'v1.0.0' };
  assert.deepEqual(storedFile(launch, ARTICLE), { kind: 'draft', channel: 'blog', piece: 'article:en' });
  assert.deepEqual(storedFile(launch, BLUESKY), { kind: 'draft', channel: 'bluesky', piece: 'post' });
  assert.deepEqual(storedFile(launch, REDDIT), { kind: 'draft', channel: 'reddit', piece: 'selfhosted' });
  assert.deepEqual(storedFile(launch, `${D}/release-notes.md`), { kind: 'draft', channel: 'releaseNotes', piece: 'notes' });
  assert.deepEqual(storedFile(launch, `${D}/pack.json`), { kind: 'pack' });
  assert.deepEqual(storedFile(launch, `public/${D}/instagram-02.mp4`), { kind: 'media', publicPath: `/${D}/instagram-02.mp4`, role: 'carousel', shared: false });
  assert.deepEqual(storedFile(launch, 'public/covers/claudio.jpg'), { kind: 'media', publicPath: '/covers/claudio.jpg', role: 'cover', shared: true });
  assert.deepEqual(storedFile(launch, 'projects.yml'), { kind: 'site' });
  assert.deepEqual(storedFile({ repo: LAUNCHES, ref: 'article:hola' }, 'articles/hola/launch.yml'), { kind: 'channels' });
});
