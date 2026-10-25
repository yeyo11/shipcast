import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Brand, ContentPack, LaunchConfig } from '@shipcast/schema';
import { GitHubRest, launchDir, pullRequestBody, renderDrafts, screenshotPaths, withScreenshot, type DraftFile } from '../src/index.ts';
import { memoryRegistry } from '../src/testing.ts';

const text = (file: DraftFile | undefined): string => (file && 'content' in file ? file.content : '');

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
// Reddit is off by default; turned on here so its drafts are still checked
const config = LaunchConfig.parse({ enabled: true, brand: 'personal', publishing: { reddit: 'manual' }, reddit: { subreddits: ['ClaudeAI'] } });
const launch = (await (await memoryRegistry()).claim({ repo: 'yeyo11/claudio', ref: 'v0.9.0', trigger: 'release', kind: 'launch', brand: 'personal' })).launch;

const pack = ContentPack.parse({
  schemaVersion: 1,
  kind: 'launch',
  project: { name: 'claudio', repo: 'https://github.com/yeyo11/claudio', version: 'v0.9.0' },
  analysis: { summary: 'Claude Code as a service.', implemented: ['REST API', 'Web UI'], planned: ['macOS app'], documentedOnly: [], limitations: ['One provider'] },
  article: {
    tags: ['claude', 'self-hosted'],
    en: { slug: 'claudio', title: 'claudio: "Claude Code" as a service', description: 'Run Claude Code from anywhere.', markdown: 'Body in English.\n' },
    es: { slug: 'claudio-como-servicio', title: 'claudio: Claude Code como servicio', description: 'Claude Code desde cualquier sitio.', markdown: 'Cuerpo en español.' },
  },
  devto: { tags: ['claude', 'ai'] },
  bluesky: { lang: 'en', text: 'Bluesky post' },
  mastodon: { lang: 'en', text: 'Mastodon post #claude' },
  instagram: { caption: 'Caption. Link in bio.', summary: 'Claude Code as a service.', slides: [{ title: 'Chats', text: 'From anywhere.' }, { title: 'Agents', text: 'In parallel.' }] },
  reddit: [{ subreddit: 'ClaudeAI', title: 'I built claudio', body: 'What and why.' }],
});

test('the drafts put each article where the blog reads it, with front matter the blog validates', () => {
  const files = renderDrafts(pack, launch, config, brand, new Date('2026-10-25T09:00:00Z'));
  const en = files.find((f) => f.path === 'src/content/posts/en/claudio.md');
  assert.ok(en);
  assert.equal(
    text(en),
    [
      '---',
      'title: "claudio: \\"Claude Code\\" as a service"',
      'description: "Run Claude Code from anywhere."',
      'pubDate: 2026-10-25',
      'lang: en',
      'translationKey: "claudio"',
      'repo: "https://github.com/yeyo11/claudio"',
      'version: "v0.9.0"',
      'tags: ["claude", "self-hosted"]',
      '---',
      '',
      'Body in English.',
      '',
    ].join('\n'),
  );
  assert.ok(files.some((f) => f.path === 'src/content/posts/es/claudio-como-servicio.md'), 'each language under its own slug');
});

test('every channel gets a readable draft that says its mode, and the pack travels with them', () => {
  const files = renderDrafts(pack, launch, config, brand, new Date('2026-10-25'));
  const dir = launchDir(launch);
  assert.equal(dir, 'launches/claudio/v0.9.0');
  assert.deepEqual(
    files.map((f) => f.path).filter((p) => p.startsWith(dir)),
    [`${dir}/devto.md`, `${dir}/bluesky.md`, `${dir}/mastodon.md`, `${dir}/instagram.md`, `${dir}/reddit-claudeai.md`, `${dir}/pack.json`],
  );
  const reddit = text(files.find((f) => f.path.endsWith('reddit-claudeai.md')));
  assert.match(reddit, /\*\*Manual:\*\* Shipcast never posts this/);
  assert.match(reddit, /# Reddit, r\/ClaudeAI/);
  assert.match(text(files.find((f) => f.path.endsWith('bluesky.md'))), /\*\*Approval:\*\* published when this pull request is merged/);
  assert.match(text(files.find((f) => f.path.endsWith('devto.md'))), /canonical URL set to https:\/\/josegarrido\.dev\/en\/claudio\//);
  const instagram = text(files.find((f) => f.path.endsWith('instagram.md')));
  assert.match(instagram, /^1\. Cover: claudio: "Claude Code" as a service\. Claude Code as a service\.$/m);
  assert.match(instagram, /^Comment: Full write-up: josegarrido\.dev\/en\/claudio\/ \(link in bio\)\. What would you use it for\?$/m);
  assert.match(instagram, /^---\n\nCaption\. Link in bio\.$/m);
  assert.deepEqual(JSON.parse(text(files.find((f) => f.path.endsWith('pack.json')))), pack);
});

test('a channel set to off gets no draft', () => {
  const quiet = LaunchConfig.parse({ enabled: true, brand: 'personal', publishing: { mastodon: 'off', instagram: 'off' } });
  const paths = renderDrafts(pack, launch, quiet, brand, new Date()).map((f) => f.path);
  assert.ok(!paths.some((p) => p.endsWith('mastodon.md') || p.endsWith('instagram.md')));
  assert.ok(!paths.some((p) => p.includes('reddit')), 'Reddit gets no draft unless launch.yml turns it on');
});

test('the pull request body shows what the code analysis found and what merging does', () => {
  const body = pullRequestBody(pack, launch, config);
  assert.match(body, /\*\*Merging publishes\*\*/);
  assert.match(body, /- REST API\n- Web UI/);
  assert.match(body, /\*\*Planned, not presented as working\*\*\n- macOS app/);
  assert.match(body, /\*\*Claimed by the docs but not backed by the code\*\*\n- none/);
  assert.match(body, /- \*\*reddit\*\*: manual/);
});

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeGitHub(answers: Record<string, () => Response>, calls: Call[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname + url.search;
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(answers).find((k) => `${method} ${path}`.startsWith(k));
    if (!key) throw new Error(`unexpected ${method} ${path}`);
    return answers[key]!();
  }) as typeof fetch;
}

const draft = {
  repo: 'yeyo11/launches',
  branch: 'launch/claudio-v0.9.0',
  base: 'main',
  title: 'Launch claudio v0.9.0',
  body: 'body',
  message: 'launch: claudio v0.9.0',
  files: [{ path: 'a.md', content: 'A' }],
};

test('a pull request is opened from one commit with every file, on a fresh branch off main', async () => {
  const calls: Call[] = [];
  const github = new GitHubRest({
    token: 't',
    fetch: fakeGitHub(
      {
        'GET /repos/yeyo11/launches/pulls': () => Response.json([]),
        'GET /repos/yeyo11/launches/git/ref/heads/main': () => Response.json({ object: { sha: 'base-sha' } }),
        'GET /repos/yeyo11/launches/git/commits/base-sha': () => Response.json({ tree: { sha: 'base-tree' } }),
        'POST /repos/yeyo11/launches/git/trees': () => Response.json({ sha: 'new-tree' }, { status: 201 }),
        'POST /repos/yeyo11/launches/git/commits': () => Response.json({ sha: 'new-commit' }, { status: 201 }),
        'POST /repos/yeyo11/launches/git/refs': () => Response.json({}, { status: 201 }),
        'POST /repos/yeyo11/launches/pulls': () => Response.json({ number: 7, html_url: 'https://github.com/yeyo11/launches/pull/7' }, { status: 201 }),
      },
      calls,
    ),
  });
  assert.deepEqual(await github.openPullRequest(draft), { number: 7, url: 'https://github.com/yeyo11/launches/pull/7', created: true });
  assert.deepEqual(calls.find((c) => c.path.endsWith('/git/trees'))?.body, {
    base_tree: 'base-tree',
    tree: [{ path: 'a.md', mode: '100644', type: 'blob', content: 'A' }],
  });
  assert.deepEqual(calls.find((c) => c.path.endsWith('/git/commits'))?.body, { message: 'launch: claudio v0.9.0', tree: 'new-tree', parents: ['base-sha'] });
  assert.deepEqual(calls.find((c) => c.path.endsWith('/git/refs'))?.body, { ref: 'refs/heads/launch/claudio-v0.9.0', sha: 'new-commit' });
});

test('binary files are uploaded as base64 blobs and referenced by sha in the tree', async () => {
  const calls: Call[] = [];
  const github = new GitHubRest({
    token: 't',
    fetch: fakeGitHub(
      {
        'GET /repos/yeyo11/launches/pulls': () => Response.json([]),
        'GET /repos/yeyo11/launches/git/ref/heads/main': () => Response.json({ object: { sha: 'b' } }),
        'GET /repos/yeyo11/launches/git/commits/b': () => Response.json({ tree: { sha: 't' } }),
        'POST /repos/yeyo11/launches/git/blobs': () => Response.json({ sha: 'blob-1' }, { status: 201 }),
        'POST /repos/yeyo11/launches/git/trees': () => Response.json({ sha: 'nt' }),
        'POST /repos/yeyo11/launches/git/commits': () => Response.json({ sha: 'nc' }),
        'POST /repos/yeyo11/launches/git/refs': () => Response.json({}, { status: 201 }),
        'POST /repos/yeyo11/launches/pulls': () => Response.json({ number: 9, html_url: 'u9' }),
      },
      calls,
    ),
  });
  await github.openPullRequest({ ...draft, files: [{ path: 'a.md', content: 'A' }, { path: 'public/og.png', bytes: new Uint8Array([137, 80, 78, 71]) }] });
  assert.deepEqual(calls.find((c) => c.path.endsWith('/git/blobs'))?.body, { content: 'iVBORw==', encoding: 'base64' });
  assert.deepEqual(calls.find((c) => c.path.endsWith('/git/trees'))?.body, {
    base_tree: 't',
    tree: [
      { path: 'a.md', mode: '100644', type: 'blob', content: 'A' },
      { path: 'public/og.png', mode: '100644', type: 'blob', sha: 'blob-1' },
    ],
  });
});

test('an open pull request for the branch is returned instead of a second one', async () => {
  const calls: Call[] = [];
  const github = new GitHubRest({
    token: 't',
    fetch: fakeGitHub({ 'GET /repos/yeyo11/launches/pulls': () => Response.json([{ number: 7, html_url: 'u7' }]) }, calls),
  });
  assert.deepEqual(await github.openPullRequest(draft), { number: 7, url: 'u7', created: false });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.path, /head=yeyo11:launch%2Fclaudio-v0\.9\.0/);
});

test('a branch left from a closed attempt is moved to the new commit', async () => {
  const calls: Call[] = [];
  const github = new GitHubRest({
    token: 't',
    fetch: fakeGitHub(
      {
        'GET /repos/yeyo11/launches/pulls': () => Response.json([]),
        'GET /repos/yeyo11/launches/git/ref/heads/main': () => Response.json({ object: { sha: 'b' } }),
        'GET /repos/yeyo11/launches/git/commits/b': () => Response.json({ tree: { sha: 't' } }),
        'POST /repos/yeyo11/launches/git/trees': () => Response.json({ sha: 'nt' }),
        'POST /repos/yeyo11/launches/git/commits': () => Response.json({ sha: 'nc' }),
        'POST /repos/yeyo11/launches/git/refs': () => Response.json({ message: 'Reference already exists' }, { status: 422 }),
        'PATCH /repos/yeyo11/launches/git/refs/heads/launch%2Fclaudio-v0.9.0': () => Response.json({}),
        'POST /repos/yeyo11/launches/pulls': () => Response.json({ number: 8, html_url: 'u8' }),
      },
      calls,
    ),
  });
  assert.equal((await github.openPullRequest(draft)).number, 8);
  assert.deepEqual(calls.find((c) => c.method === 'PATCH')?.body, { sha: 'nc', force: true });
});

test('the phase 5 channels get their drafts with the right mode lines', () => {
  const full = ContentPack.parse({
    ...pack,
    hashnode: { tags: ['claude', 'ai'] },
    telegram: { text: 'Telegram post' },
    discord: { text: 'Discord message' },
    hackerNews: { title: 'Show HN: claudio', firstComment: 'First comment.' },
    productHunt: { tagline: 'Claude Code as a service', description: 'Run it anywhere.', firstComment: 'Maker comment.' },
  });
  const on = LaunchConfig.parse({
    enabled: true,
    brand: 'personal',
    publishing: { hashnode: 'approval', telegram: 'auto', discord: 'approval', hackerNews: 'manual', productHunt: 'manual' },
  });
  const files = renderDrafts(full, launch, on, brand, new Date('2026-10-25'));
  const dir = launchDir(launch);
  const file = (name: string) => text(files.find((f) => f.path === `${dir}/${name}`));

  assert.match(file('hashnode.md'), /original URL set to https:\/\/josegarrido\.dev\/en\/claudio\/[\s\S]*Tags: `claude`, `ai`/);
  assert.match(file('hashnode.md'), /\*\*Approval:\*\*/);
  assert.match(file('telegram.md'), /\*\*Auto:\*\*[\s\S]*Telegram post/);
  assert.match(file('discord.md'), /\*\*Approval:\*\*[\s\S]*Discord message/);
  const hn = file('show-hn.md');
  assert.match(hn, /\*\*Manual:\*\*/);
  assert.match(hn, /Title: Show HN: claudio/);
  assert.match(hn, /URL to submit: https:\/\/github\.com\/yeyo11\/claudio/);
  assert.match(hn, /First comment[\s\S]*First comment\./);
  const ph = file('product-hunt.md');
  assert.match(ph, /\*\*Manual:\*\*/);
  assert.match(ph, /Tagline: Claude Code as a service/);
  assert.match(ph, /Maker comment\./);
  assert.match(ph, /^- og\.png$/m);
  assert.match(ph, /^- instagram-01\.jpg$/m);
  assert.match(ph, /^- instagram-04\.jpg$/m);
  assert.match(pullRequestBody(full, launch, on), /- \*\*hackerNews\*\*: manual[\s\S]*- \*\*productHunt\*\*: manual/);
});

test('the article carries its launch image alt text and the project screenshot after its opening paragraph', () => {
  const withAlt = ContentPack.parse({
    ...pack,
    article: {
      ...pack.article!,
      en: { ...pack.article!.en!, markdown: 'claudio runs Claude Code as a service.\n\n## How do I install it?\n\nWith Docker.', imageAlt: 'The claudio launch card: Claude Code as a service' },
    },
  });
  const files = renderDrafts(withAlt, launch, config, brand, new Date('2026-10-25'), '/launches/claudio/v0.9.0/og.png', ['/launches/claudio/v0.9.0/screenshots/home-desktop.png']);
  const en = text(files.find((f) => f.path === 'src/content/posts/en/claudio.md'));
  assert.match(en, /^imageAlt: "The claudio launch card: Claude Code as a service"$/m);
  assert.match(en, /Claude Code as a service\.\n\n!\[claudio, screenshot\]\(\/launches\/claudio\/v0\.9\.0\/screenshots\/home-desktop\.png\)\n\n## How do I install it\?/);
  const es = text(files.find((f) => f.path === 'src/content/posts/es/claudio-como-servicio.md'));
  assert.match(es, /^imageAlt: "claudio: claudio: Claude Code como servicio"$/m, 'without one from the AI, the project and the title');
  assert.match(es, /!\[claudio, captura de pantalla\]/);
});

test('the desktop screenshots are found among the media, the home page first, and placed once', () => {
  const files: DraftFile[] = [
    { path: 'public/launches/claudio/v1/screenshots/docs-desktop.png', bytes: new Uint8Array() },
    { path: 'public/launches/claudio/v1/screenshots/home-mobile.png', bytes: new Uint8Array() },
    { path: 'public/launches/claudio/v1/screenshots/home-desktop.png', bytes: new Uint8Array() },
    { path: 'public/launches/claudio/v1/og.png', bytes: new Uint8Array() },
  ];
  assert.deepEqual(screenshotPaths(files), ['/launches/claudio/v1/screenshots/home-desktop.png', '/launches/claudio/v1/screenshots/docs-desktop.png']);
  const once = withScreenshot('One.\n\nTwo.', '/s.png', 'x', 'en');
  assert.equal(withScreenshot(once, '/s.png', 'x', 'en'), once);
  assert.equal(withScreenshot('Only one paragraph.', '/s.png', 'x', 'en'), 'Only one paragraph.\n\n![x, screenshot](/s.png)');
});
