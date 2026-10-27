import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LaunchConfig } from '@shipcast/schema';
import { channelPlan, ConfigError, launchTarget, loadCiConfig, networkEnv, publishTarget } from '../src/index.ts';

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';

test('the environment maps onto the CI configuration: token, AI, state branch and the run as the holder', () => {
  const config = loadCiConfig(
    {
      SHIPCAST_LAUNCHES_REPO: 'me/launches',
      SHIPCAST_GITHUB_TOKEN: 'ghs_x',
      ANTHROPIC_API_KEY: 'sk-ant-x',
      GITHUB_REPOSITORY: 'me/app',
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '2',
      RUNNER_TEMP: '/tmp/runner',
    },
    { needAi: true },
  );
  assert.deepEqual(config.github, { kind: 'token', token: 'ghs_x', source: 'SHIPCAST_GITHUB_TOKEN' });
  assert.deepEqual(config.ai, { kind: 'anthropic', apiKey: 'sk-ant-x', model: undefined });
  assert.deepEqual(config.state, { kind: 'branch', remote: 'https://github.com/me/launches.git', branch: 'shipcast-state' });
  assert.equal(config.holder, 'me/app run 42.2');
  assert.equal(config.workDir, '/tmp/runner/shipcast');
  assert.equal(config.leaseMs, 30 * 60_000);
});

test('the GitHub App, an OpenAI-compatible server and the owner’s Postgres are chosen by their variables', () => {
  const config = loadCiConfig(
    {
      SHIPCAST_LAUNCHES_REPO: 'me/launches',
      SHIPCAST_GITHUB_APP_ID: '123',
      SHIPCAST_GITHUB_APP_PRIVATE_KEY: PEM.replace(/\n/g, '\\n'),
      SHIPCAST_AI_BASE_URL: 'https://llm.example/v1',
      SHIPCAST_AI_MODEL: 'qwen3-coder',
      SHIPCAST_DATABASE_URL: 'postgres://u:p@db.example/shipcast',
      GITHUB_TOKEN: 'ignored while the App is set',
    },
    { needAi: true },
  );
  assert.equal(config.github.kind, 'app');
  assert.ok(config.github.kind === 'app' && config.github.privateKey.includes('\nabc\n'), 'escaped newlines become newlines');
  assert.deepEqual(config.ai, { kind: 'openaiCompatible', baseUrl: 'https://llm.example/v1', apiKey: undefined, model: 'qwen3-coder' });
  assert.equal(config.state.kind, 'postgres');
});

test('GITHUB_TOKEN is the last fallback, and a command that drafts nothing needs no AI', () => {
  const config = loadCiConfig({ SHIPCAST_LAUNCHES_REPO: 'me/launches', GITHUB_TOKEN: 'ghs_workflow' }, { needAi: false });
  assert.deepEqual(config.github, { kind: 'token', token: 'ghs_workflow', source: 'GITHUB_TOKEN' });
  assert.equal(config.ai, undefined);
});

test('every missing or wrong variable is reported at once, with no value echoed', () => {
  assert.throws(
    () => loadCiConfig({ SHIPCAST_LAUNCHES_REPO: 'not a repo', SHIPCAST_GITHUB_APP_ID: '1', SHIPCAST_STATE_LEASE_MINUTES: '-3' }, { needAi: true }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /SHIPCAST_LAUNCHES_REPO must be owner\/name/);
      assert.match(error.message, /needs both SHIPCAST_GITHUB_APP_ID and SHIPCAST_GITHUB_APP_PRIVATE_KEY/);
      assert.match(error.message, /an AI provider/);
      assert.match(error.message, /SHIPCAST_STATE_LEASE_MINUTES/);
      return true;
    },
  );
});

test('the networks read CI’s brand, and the Search Console key is written to a file', () => {
  const written: Array<[string, string]> = [];
  const env = networkEnv({ DEVTO_API_KEY: 'k', GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"x"}' }, 'personal', '/tmp/w', (path, content) => written.push([path, content]));
  assert.equal(env.SHIPCAST_ENV_BRAND, 'personal');
  assert.equal(env.DEVTO_API_KEY, 'k');
  assert.equal(env.GOOGLE_SERVICE_ACCOUNT_FILE, '/tmp/w/google-service-account.json');
  assert.deepEqual(written, [['/tmp/w/google-service-account.json', '{"client_email":"x"}']]);
});

test('the workflow’s event becomes what to launch or publish', () => {
  const release = { action: 'published', repository: { full_name: 'me/app' }, release: { id: 9, tag_name: 'v1.0.0', prerelease: false, draft: false } };
  const fromRelease = launchTarget({ eventName: 'release', payload: release });
  assert.equal(fromRelease.kind, 'event');
  assert.ok(fromRelease.kind === 'event' && fromRelease.event.type === 'release' && fromRelease.event.tag === 'v1.0.0');
  assert.equal(launchTarget({ eventName: 'release', payload: { ...release, action: 'created' } }).kind, 'ignore');

  const publicized = launchTarget({ eventName: 'public', payload: { repository: { full_name: 'me/app' } } });
  assert.ok(publicized.kind === 'event' && publicized.event.type === 'public' && publicized.event.id === 'webhook-public-me/app', 'keyed as the App’s webhook keys it');

  assert.deepEqual(launchTarget({ eventName: 'workflow_dispatch', payload: { inputs: { ref: 'v2.0.0' } }, currentRepo: 'me/app' }), { kind: 'manual', repo: 'me/app', ref: 'v2.0.0' });
  assert.deepEqual(launchTarget({ repo: 'me/other', currentRepo: 'me/app' }), { kind: 'manual', repo: 'me/other', ref: undefined });
  assert.equal(launchTarget({ eventName: 'push' }).kind, 'ignore');

  const merged = { action: 'closed', repository: { full_name: 'me/launches' }, pull_request: { merged: true, html_url: 'https://github.com/me/launches/pull/3' } };
  assert.deepEqual(publishTarget({ eventName: 'pull_request', payload: merged, launchesRepo: 'me/launches' }), { pullRequest: 'https://github.com/me/launches/pull/3' });
  assert.ok('ignore' in (publishTarget({ eventName: 'pull_request', payload: { ...merged, pull_request: { merged: false } }, launchesRepo: 'me/launches' }) ?? {}));
  assert.equal(publishTarget({ eventName: 'schedule', launchesRepo: 'me/launches' }), undefined);
});

test('SHIPCAST_AI_PROVIDER chooses Anthropic, OpenAI or the fake provider, the key from its own secret or SHIPCAST_AI_API_KEY', () => {
  const base = { SHIPCAST_LAUNCHES_REPO: 'me/launches', GITHUB_TOKEN: 'ghs_x' };
  assert.deepEqual(loadCiConfig({ ...base, SHIPCAST_AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-o' }, { needAi: true }).ai, { kind: 'openai', apiKey: 'sk-o', model: undefined });
  assert.deepEqual(loadCiConfig({ ...base, SHIPCAST_AI_PROVIDER: 'OpenAI', SHIPCAST_AI_API_KEY: 'sk-g', SHIPCAST_AI_MODEL: 'gpt-5.4' }, { needAi: true }).ai, { kind: 'openai', apiKey: 'sk-g', model: 'gpt-5.4' });
  assert.deepEqual(loadCiConfig({ ...base, SHIPCAST_AI_PROVIDER: 'anthropic', SHIPCAST_AI_API_KEY: 'sk-a', OPENAI_API_KEY: 'ignored' }, { needAi: true }).ai, { kind: 'anthropic', apiKey: 'sk-a', model: undefined });
  assert.equal(loadCiConfig({ ...base, OPENAI_API_KEY: 'sk-o' }, { needAi: true }).ai?.kind, 'openai', 'a lone OpenAI key picks OpenAI');
  assert.deepEqual(loadCiConfig({ ...base, SHIPCAST_AI_PROVIDER: 'fake' }, { needAi: true }).ai, { kind: 'fake' });
  assert.throws(() => loadCiConfig({ ...base, SHIPCAST_AI_PROVIDER: 'openai' }, { needAi: true }), /OPENAI_API_KEY/);
  assert.throws(() => loadCiConfig({ ...base, SHIPCAST_AI_PROVIDER: 'gemini' }, { needAi: false }), /must be one of anthropic, openai, openai-compatible, fake/);
  assert.equal(loadCiConfig({ ...base, SHIPCAST_AI_PROVIDER: 'openai' }, { needAi: false }).ai, undefined, 'publishing needs no key');
});

test('a dry run’s channel plan names the secrets each channel lacks, never a value', () => {
  const config = LaunchConfig.parse({ enabled: true, brand: 'me', publishing: { instagram: 'off', reddit: 'approval', mastodon: 'auto' } });
  const plan = channelPlan(config, { DEVTO_API_KEY: 'secret-value', MASTODON_ACCESS_TOKEN: 'secret-too' });
  const by = Object.fromEntries(plan.map((p) => [p.channel, p]));
  assert.deepEqual(Object.keys(by), ['blog', 'devto', 'bluesky', 'mastodon', 'reddit', 'githubDiscussions']);
  assert.equal(by.devto?.ready, true);
  assert.equal(by.mastodon?.mode, 'auto');
  assert.equal(by.mastodon?.ready, true, 'the instance can come from brand.yml');
  assert.match(by.bluesky?.note ?? '', /BLUESKY_HANDLE and BLUESKY_APP_PASSWORD/);
  assert.equal(by.reddit?.ready, false);
  assert.doesNotMatch(JSON.stringify(plan), /secret-value|secret-too/);
});
