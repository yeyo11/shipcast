import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Brand, ContentPack, LaunchConfig } from '@shipcast/schema';
import { GitHubRest, launchDir, pullRequestBody, Registry, renderDrafts, type DraftFile } from '../src/index.ts';

const text = (file: DraftFile | undefined): string => (file && 'content' in file ? file.content : '');

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
const config = LaunchConfig.parse({ enabled: true, brand: 'personal', reddit: { subreddits: ['ClaudeAI'] } });
const launch = new Registry(':memory:').claim({ repo: 'yeyo11/claudio', ref: 'v0.9.0', trigger: 'release', kind: 'launch', brand: 'personal' }).launch;

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
  instagram: { caption: 'Caption. Link in bio.', media: 'demo-video' },
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
  assert.match(text(files.find((f) => f.path.endsWith('instagram.md'))), /the demo, as a Reel/);
  assert.deepEqual(JSON.parse(text(files.find((f) => f.path.endsWith('pack.json')))), pack);
});

test('a channel set to off gets no draft', () => {
  const quiet = LaunchConfig.parse({ enabled: true, brand: 'personal', publishing: { mastodon: 'off', instagram: 'off' } });
  const paths = renderDrafts(pack, launch, quiet, brand, new Date()).map((f) => f.path);
  assert.ok(!paths.some((p) => p.endsWith('mastodon.md') || p.endsWith('instagram.md')));
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
