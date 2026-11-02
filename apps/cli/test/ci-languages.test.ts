import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { draftLaunch, loadBrand, type PipelineDeps } from '@shipcast/engine';
import { FakeGitHub, memoryRegistry } from '@shipcast/engine/testing';
import { ciPipeline } from '../src/ci.ts';

/*
 * A brand's blog languages (brand.yml's languages.blog) decide which files a launch writes, end to
 * end through Action mode with the fake AI provider: the articles, the newsletter's issues (one per
 * list language) and the pack, for English alone, for the owner's English and Spanish, and for
 * languages Shipcast has no special case for.
 */

const LAUNCH_YML = 'enabled: true\nbrand: acme\npublishing:\n  instagram: off\n  reddit: off\n  newsletter: approval\n  devto: approval\n';

const brandYml = (blog: string, lists: string) =>
  [
    'id: acme',
    'displayName: Acme',
    'site: https://example.dev',
    'github: me',
    ...(blog ? ['languages:', `  blog: [${blog}]`] : []),
    'newsletter:',
    '  sender: { name: Acme, email: news@example.dev }',
    `  lists: { ${lists} }`,
    '',
  ].join('\n');

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Drafts me/app v1.0.0 with the fake provider for a brand.yml, and answers the pull request's files */
async function draft(brandText: string) {
  const github = new FakeGitHub({
    files: { 'me/launches/brand.yml@HEAD': brandText, 'me/app/.github/launch.yml@v1.0.0': LAUNCH_YML },
    latestRelease: { tag: 'v1.0.0', url: 'u' },
  });
  const registry = await memoryRegistry();
  const hostPath = mkdtempSync(join(tmpdir(), 'shipcast-ci-languages-'));
  dirs.push(hostPath);
  mkdirSync(join(hostPath, '.github'));
  writeFileSync(join(hostPath, '.github', 'launch.yml'), LAUNCH_YML);
  const base = {
    github,
    registry,
    launchesRepo: 'me/launches',
    checkout: async () => ({ hostPath }),
    now: () => new Date('2026-11-02T00:00:00Z'),
    fetch: (async () => new Response(null, { status: 404 })) as typeof fetch,
  } satisfies Partial<PipelineDeps>;
  const brand = await loadBrand(github, 'me/launches');
  const { launch } = await registry.launches.claim({ repo: 'me/app', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'acme' });
  const result = await draftLaunch(launch, brand, ciPipeline({ kind: 'fake' }, base, { launch, brand }));
  assert.equal(result.ok, true, result.ok ? '' : result.problems.join('; '));
  const files = github.opened[0]!.files;
  const text = (path: string) => {
    const file = files.find((f) => f.path === path);
    return file && 'content' in file ? file.content : undefined;
  };
  const pack = JSON.parse(text('launches/app/v1.0.0/pack.json') ?? '{}') as { article: Record<string, unknown>; newsletter: Record<string, unknown> };
  return {
    articles: files.map((f) => f.path).filter((p) => p.startsWith('src/content/posts/')).sort(),
    issues: files.map((f) => f.path).filter((p) => /\/newsletter-[a-z]{2}\.md$/.test(p)).sort(),
    pack: { article: Object.keys(pack.article).sort(), newsletter: Object.keys(pack.newsletter).sort() },
    text,
  };
}

test('a brand that names no languages writes English alone: the article, the issue and the pack', async () => {
  const drafted = await draft(brandYml('', 'en: 4'));
  assert.deepEqual(drafted.articles, ['src/content/posts/en/app-launch.md']);
  assert.deepEqual(drafted.issues, ['launches/app/v1.0.0/newsletter-en.md']);
  assert.deepEqual(drafted.pack, { article: ['en', 'tags'], newsletter: ['en'] });
  assert.match(drafted.text('src/content/posts/en/app-launch.md') ?? '', /^lang: en\ntranslationKey: "app-launch"$/m);
  assert.match(drafted.text('launches/app/v1.0.0/devto.md') ?? '', /Republishes the English article with its canonical URL set to https:\/\/example\.dev\/en\/app-launch\/\./);
});

test('English and Spanish, the owner’s brand, write both as they always have', async () => {
  const drafted = await draft(brandYml('en, es', 'en: 4, es: 5'));
  assert.deepEqual(drafted.articles, ['src/content/posts/en/app-launch.md', 'src/content/posts/es/app-lanzamiento.md']);
  assert.deepEqual(drafted.issues, ['launches/app/v1.0.0/newsletter-en.md', 'launches/app/v1.0.0/newsletter-es.md']);
  assert.deepEqual(drafted.pack, { article: ['en', 'es', 'tags'], newsletter: ['en', 'es'] });
  // Paired by the English slug, as every launch before languages were configurable
  assert.match(drafted.text('src/content/posts/es/app-lanzamiento.md') ?? '', /^translationKey: "app-launch"$/m);
});

test('any other language is written too: English and French, each issue per list', async () => {
  const drafted = await draft(brandYml('en, fr', 'en: 4, fr: 6'));
  assert.deepEqual(drafted.articles, ['src/content/posts/en/app-launch.md', 'src/content/posts/fr/app-launch.md']);
  assert.deepEqual(drafted.issues, ['launches/app/v1.0.0/newsletter-en.md', 'launches/app/v1.0.0/newsletter-fr.md']);
  assert.deepEqual(drafted.pack, { article: ['en', 'fr', 'tags'], newsletter: ['en', 'fr'] });
  assert.match(drafted.text('src/content/posts/fr/app-launch.md') ?? '', /^lang: fr\ntranslationKey: "app-launch"$/m);
});

test('a brand with no English: its primary language is the lead one, which dev.to republishes', async () => {
  const drafted = await draft(brandYml('de', 'de: 7'));
  assert.deepEqual(drafted.articles, ['src/content/posts/de/app-launch.md']);
  assert.deepEqual(drafted.issues, ['launches/app/v1.0.0/newsletter-de.md']);
  assert.deepEqual(drafted.pack, { article: ['de', 'tags'], newsletter: ['de'] });
  assert.match(drafted.text('launches/app/v1.0.0/devto.md') ?? '', /Republishes the German article with its canonical URL set to https:\/\/example\.dev\/de\/app-launch\/\./);
});
