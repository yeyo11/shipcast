import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubError, GitHubRest, preflight, type PreflightSource } from '../src/index.ts';

const YML = 'enabled: true\nbrand: personal\n';
const YML_DEMO = `${YML}assets:\n  demo: docs/demo.gif\n`;
const YML_URL = `${YML}assets:\n  demo: https://example.com/demo.gif\n`;

interface World {
  releases?: Record<string, { draft: boolean }>;
  latest?: string;
  files?: Record<string, string>;
  license?: { spdx: string | undefined };
  readme?: boolean;
  paths?: string[];
  heads?: Record<string, number>;
}

/** Everything is fine unless the world says otherwise. */
function fake(world: World = {}): PreflightSource {
  const releases = world.releases ?? { 'v1.0.0': { draft: false } };
  const files = world.files ?? { '.github/launch.yml': YML_DEMO };
  return {
    async releaseByTag(_repo, tag) {
      const r = releases[tag];
      return r ? { tag, url: `https://github.com/o/r/releases/tag/${tag}`, draft: r.draft } : undefined;
    },
    async latestRelease() {
      return world.latest === undefined ? undefined : { tag: world.latest, url: 'u' };
    },
    async fileAt(_repo, path) {
      return files[path];
    },
    async license() {
      return 'license' in world ? world.license : { spdx: 'MIT' };
    },
    async hasReadme() {
      return world.readme ?? true;
    },
    async pathExists(_repo, path) {
      return (world.paths ?? ['docs/demo.gif']).includes(path);
    },
    async head(url) {
      return world.heads?.[url] ?? 404;
    },
  };
}

const failed = (result: Awaited<ReturnType<typeof preflight>>) => result.checks.filter((c) => !c.ok).map((c) => c.id);

test('a ready repo passes every check', async () => {
  const result = await preflight('o/r', 'v1.0.0', { github: fake() });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.checks.map((c) => c.id),
    ['release', 'launchYml', 'license', 'readme', 'demo'],
  );
  assert.deepEqual(failed(result), []);
  assert.match(result.checks.find((c) => c.id === 'license')?.detail ?? '', /MIT/);
});

test('no ref checks the latest release and reads the files at its tag', async () => {
  const result = await preflight('o/r', undefined, { github: fake({ latest: 'v2.0.0' }) });
  assert.equal(result.ok, true);
  assert.equal(result.ref, undefined);
  assert.match(result.checks[0]?.detail ?? '', /v2\.0\.0/);
});

test('no ref and no release fails the release check', async () => {
  const result = await preflight('o/r', undefined, { github: fake() });
  assert.equal(result.ok, false);
  assert.deepEqual(failed(result), ['release']);
});

test('a missing tag and a draft release both fail', async () => {
  const missing = await preflight('o/r', 'v9', { github: fake() });
  assert.deepEqual(failed(missing).slice(0, 1), ['release']);
  assert.equal(missing.ok, false);
  const draft = await preflight('o/r', 'v1.0.0', { github: fake({ releases: { 'v1.0.0': { draft: true } } }) });
  assert.equal(draft.ok, false);
  assert.match(draft.checks[0]?.detail ?? '', /draft/);
});

test('launch.yml missing, invalid or disabled fails', async () => {
  const missing = await preflight('o/r', 'v1.0.0', { github: fake({ files: {} }) });
  assert.ok(failed(missing).includes('launchYml'));
  assert.equal(missing.ok, false);

  const invalid = await preflight('o/r', 'v1.0.0', { github: fake({ files: { '.github/launch.yml': 'enabled: [oops\n' } }) });
  assert.ok(failed(invalid).includes('launchYml'));
  assert.match(invalid.checks[1]?.detail ?? '', /invalid/);
  assert.equal(invalid.ok, false);

  const disabled = await preflight('o/r', 'v1.0.0', { github: fake({ files: { '.github/launch.yml': 'enabled: false\nbrand: personal\n' } }) });
  assert.match(disabled.checks[1]?.detail ?? '', /enabled: false/);
  assert.equal(disabled.ok, false);
});

test('a missing or unrecognised license fails', async () => {
  const none = await preflight('o/r', 'v1.0.0', { github: fake({ license: undefined }) });
  assert.deepEqual(failed(none), ['license']);
  assert.match(none.checks[2]?.detail ?? '', /No LICENSE/);
  const unknown = await preflight('o/r', 'v1.0.0', { github: fake({ license: { spdx: undefined } }) });
  assert.deepEqual(failed(unknown), ['license']);
  assert.equal(unknown.ok, false);
});

test('a missing README fails', async () => {
  const result = await preflight('o/r', 'v1.0.0', { github: fake({ readme: false }) });
  assert.deepEqual(failed(result), ['readme']);
  assert.equal(result.ok, false);
});

test('a demo path missing from the repo fails as required', async () => {
  const result = await preflight('o/r', 'v1.0.0', { github: fake({ paths: [] }) });
  const demo = result.checks.find((c) => c.id === 'demo');
  assert.equal(demo?.ok, false);
  assert.equal(demo?.required, true);
  assert.equal(result.ok, false);
});

test('a demo URL passes on 200 and fails otherwise', async () => {
  const files = { '.github/launch.yml': YML_URL };
  const up = await preflight('o/r', 'v1.0.0', { github: fake({ files, heads: { 'https://example.com/demo.gif': 200 } }) });
  assert.equal(up.ok, true);
  const down = await preflight('o/r', 'v1.0.0', { github: fake({ files }) });
  assert.equal(down.ok, false);
  assert.match(down.checks[4]?.detail ?? '', /answered 404/);
  const unreachable = fake({ files });
  unreachable.head = async () => {
    throw new Error('offline');
  };
  const result = await preflight('o/r', 'v1.0.0', { github: unreachable });
  assert.match(result.checks[4]?.detail ?? '', /cannot be reached/);
});

test('no assets.demo is a failed check that does not block', async () => {
  const result = await preflight('o/r', 'v1.0.0', { github: fake({ files: { '.github/launch.yml': YML } }) });
  const demo = result.checks.find((c) => c.id === 'demo');
  assert.equal(demo?.ok, false);
  assert.equal(demo?.required, false);
  assert.match(demo?.detail ?? '', /demo GIF/);
  assert.equal(result.ok, true);
});

interface Seen {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
}

function rest(responses: Array<Response | Error>, seen: Seen[]): GitHubRest {
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), method: init?.method, headers: (init?.headers ?? {}) as Record<string, string> });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return new GitHubRest({ token: 't0k3n', fetch: fetcher });
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test('releaseByTag reads the tag, tells drafts apart and maps 404 to undefined', async () => {
  const seen: Seen[] = [];
  const github = rest([json({ tag_name: 'v1.0.0', html_url: 'u', draft: true }), json({}, 404), json({}, 500)], seen);
  assert.deepEqual(await github.releaseByTag('o/r', 'v1.0.0'), { tag: 'v1.0.0', url: 'u', draft: true });
  assert.equal(seen[0]?.url, 'https://api.github.com/repos/o/r/releases/tags/v1.0.0');
  assert.equal(await github.releaseByTag('o/r', 'nope'), undefined);
  await assert.rejects(github.releaseByTag('o/r', 'v2'), GitHubError);
});

test('license returns the SPDX id, undefined for NOASSERTION, and undefined for 404', async () => {
  const seen: Seen[] = [];
  const github = rest([json({ license: { spdx_id: 'MIT' } }), json({ license: { spdx_id: 'NOASSERTION' } }), json({}, 404)], seen);
  assert.deepEqual(await github.license('o/r'), { spdx: 'MIT' });
  assert.equal(seen[0]?.url, 'https://api.github.com/repos/o/r/license');
  assert.deepEqual(await github.license('o/r'), { spdx: undefined });
  assert.equal(await github.license('o/r'), undefined);
});

test('hasReadme and pathExists pass the ref and treat 404 as absent', async () => {
  const seen: Seen[] = [];
  const github = rest([json({}), json({}, 404), json({}), json({}, 404), json({}, 403)], seen);
  assert.equal(await github.hasReadme('o/r', 'v1.0.0'), true);
  assert.equal(seen[0]?.url, 'https://api.github.com/repos/o/r/readme?ref=v1.0.0');
  assert.equal(await github.hasReadme('o/r', 'HEAD'), false);
  assert.equal(seen[1]?.url, 'https://api.github.com/repos/o/r/readme');
  assert.equal(await github.pathExists('o/r', 'docs/demo.gif', 'v1.0.0'), true);
  assert.equal(seen[2]?.url, 'https://api.github.com/repos/o/r/contents/docs/demo.gif?ref=v1.0.0');
  assert.equal(await github.pathExists('o/r', 'x.gif', 'v1.0.0'), false);
  await assert.rejects(github.pathExists('o/r', 'x.gif', 'v1.0.0'), GitHubError);
});

test('head sends a HEAD without the token and returns the status', async () => {
  const seen: Seen[] = [];
  const github = rest([new Response(null, { status: 200 })], seen);
  assert.equal(await github.head('https://example.com/demo.gif'), 200);
  assert.equal(seen[0]?.method, 'HEAD');
  assert.equal(seen[0]?.headers.authorization, undefined);
});

test('a site in place of a demo passes when it answers, and says the demo will be recorded', async () => {
  const files = { '.github/launch.yml': `${YML}assets:\n  site: https://example.com\n` };
  const up = await preflight('o/r', 'v1.0.0', { github: fake({ files, heads: { 'https://example.com': 200 } }) });
  const demo = up.checks.find((c) => c.id === 'demo');
  assert.equal(demo?.ok, true);
  assert.match(demo?.detail ?? '', /recorded from https:\/\/example\.com/);
  assert.equal(up.ok, true);
  const down = await preflight('o/r', 'v1.0.0', { github: fake({ files }) });
  assert.equal(down.ok, false);
  assert.match(down.checks.find((c) => c.id === 'demo')?.detail ?? '', /answered 404/);
});
