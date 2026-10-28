import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { YouTubePublished, YouTubeVideo } from '@shipcast/connectors';
import { Brand, ContentPack, parseLaunchConfig, parseYouTubeDraft, YOUTUBE_VIDEOS, youtubeDraft } from '@shipcast/schema';
import { bindStrategy, collectMetrics, editPost, PRIVATE_UNTIL_AUDIT, PublishingService, renderDrafts, youtubeKind, youtubePrivacyKey, youtubeStrategy, type ChangeEditor, type Editors, type YouTubeStrategyOptions } from '../src/index.ts';
import { aLaunch, FakeGitHub, LAUNCHES_REPO, memoryRegistry } from '../src/testing/index.ts';

/*
 * YouTube published as a channel the engine has no run built in for: its strategy renders the two
 * videos and uploads them through PublishingService, and its edits, numbers and drafts go through the
 * generic paths every new network takes.
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
const D = 'launches/claudio/v1.0.0';
const card = (title: string, seconds: number, chapter?: string) => ({ kind: 'card' as const, title, subtitle: `${title}, said`, seconds, ...(chapter && { chapter }) });
const youtube = {
  short: { title: 'claudio in 10 seconds', description: 'Claude Code behind an API.', tags: ['claude'], lang: 'en' as const, scenes: [card('claudio', 3), { kind: 'cover' as const, subtitle: 'The cover', seconds: 3 }] },
  video: {
    title: 'claudio, a walk-through',
    description: 'What claudio does and how.',
    tags: ['claude', 'api'],
    lang: 'en' as const,
    scenes: [card('What it is', 20, 'What it is'), { kind: 'demo' as const, subtitle: 'It runs', seconds: 20, chapter: 'Demo' }, { kind: 'screenshot' as const, screenshot: 1, subtitle: 'The page', seconds: 20, chapter: 'The page' }],
  },
};
const pack = {
  schemaVersion: 1,
  kind: 'launch',
  project: { name: 'claudio', repo: 'https://github.com/yeyo11/claudio', version: 'v1.0.0' },
  analysis: { summary: 's', implemented: ['x'], planned: [], documentedOnly: [], limitations: [] },
  article: { en: { slug: 'claudio', title: 'T', description: 'D', markdown: 'B' } },
  youtube,
};
const LAUNCH_YML = 'enabled: true\nbrand: personal\npublishing:\n  devto: off\n  instagram: off\n  githubDiscussions: off\n  youtube: auto\nassets:\n  site: https://claudio.example\n  screenshots:\n    - path: /\n';

function github(): FakeGitHub {
  return new FakeGitHub({
    pullRequestState: 'merged',
    files: {
      [`${LAUNCHES_REPO}/${D}/pack.json@HEAD`]: JSON.stringify(pack),
      // The owner changed the Short's title in the pull request
      [`${LAUNCHES_REPO}/${D}/youtube-short.md@HEAD`]: `# YouTube, the Short\n\n> **Auto:** published.\n\n${youtubeDraft({ ...youtube.short, title: 'claudio, edited' })}`,
      [`${LAUNCHES_REPO}/src/content/posts/en/claudio.md@HEAD`]: '---\ntitle: "Title"\ndescription: "Description"\n---\n\nBody.\n',
      'yeyo11/claudio/.github/launch.yml@v1.0.0': LAUNCH_YML,
    },
  });
}

/** The site: the launch's media where the launch put them, or bytes standing for them */
function site(media: Record<string, { bytes: Uint8Array; type: string }> = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const file = Object.keys(media).find((f) => url.endsWith(`/${f}`));
    if (file) return new Response(media[file]!.bytes as Uint8Array<ArrayBuffer>, { headers: { 'content-type': media[file]!.type } });
    if (url.endsWith('/og.jpg')) return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } });
    if (/\.(png|gif|mp4)$/.test(url)) return new Response(null, { status: 404 });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
}

/** YouTube faked: each upload recorded, private as Google keeps an unaudited project's */
class FakeYouTube {
  readonly uploads: YouTubeVideo[] = [];
  async publish(video: YouTubeVideo): Promise<YouTubePublished> {
    this.uploads.push(video);
    const id = `yt-${this.uploads.length}`;
    return { externalId: id, url: video.short ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`, privacy: 'private', extras: video.short ? ['thumbnail: a custom thumbnail needs a verified channel'] : [] };
  }
}

const fakeRender: YouTubeStrategyOptions = {
  render: async (request) => ({
    srt: `1\n00:00:00,000 --> 00:00:01,000\n${request.scenes[0]?.subtitle ?? ''}\n`,
    chapters: request.scenes.flatMap((s, i) => (s.chapter ? [{ at: i * 20, title: s.chapter }] : [])),
  }),
  duration: async () => 5,
};

async function publish(options: YouTubeStrategyOptions, media?: Parameters<typeof site>[0]) {
  const registry = await memoryRegistry();
  const launch = await aLaunch(registry);
  const yt = new FakeYouTube();
  const service = new PublishingService({ registry, github: github(), launchesRepo: LAUNCHES_REPO });
  // The fake renderer writes no file: the run reads what it rendered, so an empty one stands for it
  const strategy = youtubeStrategy(options);
  const result = await service.publish(launch, brand, { publishers: {}, strategies: { youtube: bindStrategy(strategy, yt) }, fetch: site(media) }, 'test');
  return { registry, launch, yt, result };
}

test('a launch with youtube on uploads both videos once, records them, and says Google keeps them private', async () => {
  const files: string[] = [];
  const { registry, launch, yt, result } = await publish({
    ...fakeRender,
    render: async (request) => {
      files.push(request.output);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(request.output, new Uint8Array([1, 2, 3]));
      return fakeRender.render!(request);
    },
  });
  assert.equal(result.state, 'published', JSON.stringify(result));
  const posts = await registry.posts(launch.id, { channel: 'youtube' });
  assert.deepEqual(posts.map((p) => [p.kind, p.externalId, p.url]), [
    [youtubeKind('short'), 'yt-1', 'https://www.youtube.com/shorts/yt-1'],
    [youtubeKind('video'), 'yt-2', 'https://www.youtube.com/watch?v=yt-2'],
  ]);
  const [short, video] = yt.uploads;
  assert.equal(short?.title, 'claudio, edited', 'the draft as merged');
  assert.equal(video?.title, 'claudio, a walk-through');
  assert.ok(short?.description.startsWith('https://josegarrido.dev/en/claudio/?ref=youtube\n\n'), 'the article first');
  assert.match(video?.description ?? '', /0:00 What it is\n0:20 Demo\n0:40 The page$/, 'the horizontal one ends with its chapters');
  assert.doesNotMatch(short?.description ?? '', /0:00/, 'a Short has no chapters');
  assert.deepEqual(video?.captions?.map((c) => [c.lang, c.name]), [['en', 'English']]);
  assert.equal(video?.privacy, 'public', 'public is asked for');
  assert.deepEqual([...(video?.bytes ?? [])], [1, 2, 3]);
  assert.ok(video?.thumbnail, 'the cover is the thumbnail');
  for (const post of posts) assert.equal(await registry.cursor(youtubePrivacyKey(post.id)), PRIVATE_UNTIL_AUDIT);
  assert.ok(result.state === 'published' && result.failures.length === 0, 'private is not a failure');
  assert.ok(result.state === 'published' && result.problems.some((p) => p.includes(PRIVATE_UNTIL_AUDIT)));
  assert.ok(result.state === 'published' && result.problems.some((p) => p.includes('verified channel')), "an extra that did not go up is said, the video stays");
  assert.equal(files.length, 2);

  // Published once: the launch is done, and running it again sends nothing
  const again = await new PublishingService({ registry, github: github(), launchesRepo: LAUNCHES_REPO }).publish((await registry.get(launch.id))!, brand, { publishers: {}, strategies: { youtube: bindStrategy(youtubeStrategy(fakeRender), yt) }, fetch: site() }, 'again');
  assert.equal(again.state, 'published');
  assert.equal(yt.uploads.length, 2);
});

test('a script the renderer refuses fails the channel for good, and the other video still goes up', async () => {
  const { yt, result, registry, launch } = await publish({
    ...fakeRender,
    render: async (request) => {
      if (request.format === 'horizontal') throw new Error('the horizontal video lasts 60 to 180 s');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(request.output, new Uint8Array([1]));
      return fakeRender.render!(request);
    },
  });
  assert.equal(yt.uploads.length, 1);
  assert.equal((await registry.posts(launch.id, { channel: 'youtube' })).length, 1);
  assert.ok(result.state === 'published' || result.state === 'partial');
  assert.deepEqual(result.failures.map((f) => [f.channel, f.retryable]), [['youtube', false]]);
});

const hasFfmpeg = spawnSync('ffprobe', ['-version']).status === 0 && spawnSync('ffmpeg', ['-version']).status === 0;

test('with ffmpeg, the two videos are rendered for real from the cover, a screenshot and the demo', { skip: hasFfmpeg ? false : 'ffmpeg and ffprobe are not installed', timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yt-publish-'));
  try {
    const png = join(dir, 'cover.png');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x2FD7A0:s=320x180', '-frames:v', '1', png]);
    const gif = join(dir, 'demo.gif');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '2', gif]);
    const image = { bytes: new Uint8Array(readFileSync(png)), type: 'image/png' };
    const { yt, result } = await publish({}, { 'og.png': image, 'home-desktop.png': image, 'demo.gif': { bytes: new Uint8Array(readFileSync(gif)), type: 'image/gif' } });
    assert.equal(result.state, 'published', JSON.stringify(result));
    assert.equal(yt.uploads.length, 2);
    for (const video of yt.uploads) {
      const file = join(dir, video.short ? 'short.mp4' : 'video.mp4');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(file, video.bytes);
      const size = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
      assert.equal(size, video.short ? '1080,1920' : '1920,1080');
      const seconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());
      // The demo lasts 2 s of its 20: the 18 it leaves go to the next scene, so the video lasts its script
      assert.ok(Math.abs(seconds - (video.short ? 6 : 60)) < 1, `${seconds} s`);
      assert.match(video.captions?.[0]?.srt ?? '', /^1\n00:00:00,000 --> /);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a video's drafts are written from its piece and read back as edited", () => {
  const config = parseLaunchConfig(LAUNCH_YML);
  assert.ok(config.ok);
  const files = renderDrafts(ContentPack.parse(pack), { id: 1, repo: 'yeyo11/claudio', ref: 'v1.0.0', kind: 'launch' } as never, config.value, brand, new Date('2026-10-28'));
  const paths = files.map((f) => f.path);
  for (const part of YOUTUBE_VIDEOS) assert.ok(paths.includes(`${D}/youtube-${part}.md`), part);
  const body = youtubeDraft(youtube.video);
  assert.deepEqual(parseYouTubeDraft(body, { title: '', description: '', tags: [] }), { title: youtube.video.title, description: youtube.video.description, tags: youtube.video.tags });
  assert.deepEqual(parseYouTubeDraft(body.replace('Title: claudio, a walk-through', 'Title: New'), youtube.video).title, 'New');
});

test('a video is edited through the change editor its adapter gives, and deleted', async () => {
  const registry = await memoryRegistry();
  const launch = await aLaunch(registry, { status: 'published' });
  const { post } = await registry.recordPost({ launchId: launch.id, channel: 'youtube', kind: youtubeKind('video'), externalId: 'yt-9', url: 'https://www.youtube.com/watch?v=yt-9' });
  const calls: string[] = [];
  const editor: ChangeEditor = { edit: async (id, changes) => void calls.push(`edit ${id} ${JSON.stringify(changes)}`), delete: async (id) => void calls.push(`delete ${id}`) };
  const deps = { registry, editors: async () => ({ youtube: editor }) as unknown as Editors };
  await editPost(post.id, { text: 'New description', title: 'New title', tags: ['a'] }, deps);
  assert.deepEqual(calls, ['edit yt-9 {"text":"New description","title":"New title","tags":["a"]}']);
  await assert.rejects(editPost(post.id, { imageUrl: 'https://x.example/a.png' }, deps), /cannot change image/);
  const { deletePost } = await import('../src/index.ts');
  assert.equal((await deletePost(post.id, deps)).status, 'deleted');
  assert.deepEqual(calls.at(-1), 'delete yt-9');
  await assert.rejects(editPost(post.id, { text: 'x' }, { registry, editors: async () => ({}) }), /deleted already/);
});

test("YouTube's numbers are read in one batch for every video, and a video the answer lacks is left alone", async () => {
  const registry = await memoryRegistry();
  const launch = await aLaunch(registry, { status: 'published' });
  for (const part of YOUTUBE_VIDEOS) await registry.recordPost({ launchId: launch.id, channel: 'youtube', kind: youtubeKind(part), externalId: `yt-${part}`, url: null });
  const batches: string[][] = [];
  const reader = {
    metrics: async () => assert.fail('read one by one'),
    metricsMany: async (ids: string[]) => {
      batches.push(ids);
      return new Map([['yt-short', { views: 12, likes: 3 }]]);
    },
  };
  const result = await collectMetrics(registry, brand, { posts: { youtube: reader } }, new Date('2026-10-28T12:00:00Z'));
  assert.deepEqual(batches, [['yt-short', 'yt-video']]);
  assert.equal(result.readings, 2);
  assert.deepEqual(result.problems, []);
});
