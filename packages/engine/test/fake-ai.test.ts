import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Brand, LaunchConfig, parseLaunchConfig } from '@shipcast/schema';
import { AiTaskRunner, FAKE_NOTICE, fakePack, fakePackAiProvider, generatePack, type Launch } from '../src/index.ts';

const brand = Brand.parse({
  id: 'dev',
  displayName: 'A Developer',
  site: 'https://dev.example',
  github: 'someone',
  languages: { blog: ['en', 'es'] },
  newsletter: { sender: { name: 'A', email: 'a@dev.example' }, lists: { en: 1 } },
});

function launch(kind: Launch['kind'] = 'launch'): Launch {
  const at = '2026-10-27T00:00:00.000Z';
  return { id: 1, repo: 'someone/Tiny_Tool', ref: 'v0.1.0', trigger: 'release', kind, brand: 'dev', status: 'detected', detail: null, createdAt: at, updatedAt: at };
}

const everyChannel = 'enabled: true\nbrand: dev\npublishing:\n  reddit: approval\n  hashnode: approval\n  linkedin: approval\n  newsletter: approval\n  telegram: approval\n  discord: approval\n  threads: approval\nreddit:\n  subreddits: [node, programming]\n';

function checkoutWith(launchYml: string): { hostPath: string; providerPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'shipcast-fake-ai-'));
  mkdirSync(join(dir, '.github'));
  writeFileSync(join(dir, '.github', 'launch.yml'), launchYml);
  return { hostPath: dir, providerPath: dir };
}

test('the fake pack passes the same checks as a real one, for every channel launch.yml turns on', async () => {
  for (const yml of ['enabled: true\nbrand: dev\n', everyChannel]) {
    const checkout = checkoutWith(yml);
    const config = parseLaunchConfig(yml);
    assert.ok(config.ok);
    // On the runner's whole path: it reads launch.yml with the runner's tool and answers through the submit tool
    const runner = new AiTaskRunner({ resolve: async () => ({ provider: fakePackAiProvider(launch(), brand), settings: {} }) });
    const result = await generatePack({ runner, launch: launch(), config: config.value, brand, checkout, ref: 'v0.1.0' });
    assert.equal(result.ok, true, result.ok ? '' : result.problems.join('; '));
  }
});

test('the fake provider reads launch.yml from the clone, and fails plainly without one', async () => {
  const runner = new AiTaskRunner({ resolve: async () => ({ provider: fakePackAiProvider(launch(), brand), settings: {} }) });
  const config = LaunchConfig.parse({ enabled: true, brand: 'dev' });
  const empty = { hostPath: mkdtempSync(join(tmpdir(), 'shipcast-fake-ai-')), providerPath: '' };
  const result = await generatePack({ runner, launch: launch(), config, brand, checkout: empty, ref: 'v0.1.0' });
  assert.deepEqual(result.ok ? [] : result.problems, ['the fake AI provider could not read .github/launch.yml']);
});

test('the fake pack says it is fake, and follows the launch it was asked for', () => {
  const pack = fakePack(launch('minor'), LaunchConfig.parse({ enabled: true, brand: 'dev', publishing: { instagram: 'off' } }), brand);
  assert.equal(pack.kind, 'minor');
  assert.equal(pack.project.repo, 'https://github.com/someone/Tiny_Tool');
  assert.equal(pack.article?.en?.slug, 'tiny-tool-launch');
  assert.equal(pack.article?.es?.description, FAKE_NOTICE);
  assert.equal(pack.instagram, undefined, 'a channel turned off gets no piece');
  assert.match(pack.mastodon?.text ?? '', /Placeholder/);
});
