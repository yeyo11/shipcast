import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appEnvLines, appManifest, bootstrapEnv, parseInitArgs, refuseExisting } from '../src/init.ts';

test('the bootstrap .env holds only what the app needs before anyone signs in', () => {
  const local = bootstrapEnv({ publicUrl: undefined, login: 'yeyo11', postgresPassword: 'pw', claudioToken: 'ct' });
  assert.match(local, /^SHIPCAST_DATABASE_URL=postgres:\/\/shipcast:pw@127\.0\.0\.1:5433\/shipcast$/m);
  assert.match(local, /^POSTGRES_PASSWORD=pw$/m);
  assert.match(local, /^SHIPCAST_CLAUDIO_TOKEN=ct$/m, 'docker-compose.yml refuses to start without it');
  assert.match(local, /^SHIPCAST_ALLOWED_GITHUB=yeyo11$/m);
  assert.match(local, /^SHIPCAST_APP_TLS=off$/m, 'no address of its own: plain HTTP on this machine');
  assert.match(local, /^SHIPCAST_APP_HOST=127\.0\.0\.1$/m);
  assert.doesNotMatch(local, /LAUNCHES_REPO|CLAUDIO_URL|GITHUB_TOKEN_PERSONAL/, 'the rest is set in the onboarding');

  const served = bootstrapEnv({ publicUrl: 'https://shipcast.example.dev', login: 'yeyo11', postgresPassword: 'pw', claudioToken: 'ct' });
  assert.match(served, /^SHIPCAST_PUBLIC_URL=https:\/\/shipcast\.example\.dev$/m);
  assert.doesNotMatch(served, /^SHIPCAST_APP_TLS=off$/m);
  assert.match(served, /^SHIPCAST_TLS_CLOUDFLARE_TOKEN=$/m);
});

test("the App's manifest asks for what the engine uses, and takes webhooks only where GitHub can reach them", () => {
  const served = appManifest({ login: 'yeyo11', baseUrl: 'https://shipcast.example.dev', redirectUrl: 'http://127.0.0.1:5000/created' });
  assert.deepEqual(served.default_permissions, { metadata: 'read', contents: 'write', pull_requests: 'write', discussions: 'write' });
  assert.deepEqual(served.default_events, ['release', 'pull_request', 'repository', 'push']);
  assert.deepEqual(served.callback_urls, ['https://shipcast.example.dev/auth/github/callback']);
  assert.equal(served.public, false);
  assert.deepEqual(served.hook_attributes, { url: 'https://shipcast.example.dev/api/github/webhook', active: true });
  assert.ok(String(served.name).length <= 34, "GitHub's limit on an App's name");

  const local = appManifest({ login: 'yeyo11', baseUrl: 'http://127.0.0.1:8744', redirectUrl: 'http://127.0.0.1:5000/created' });
  assert.equal((local.hook_attributes as { active: boolean }).active, false, 'a machine nobody reaches polls instead');
});

test("the App's .env lines point at the key file, never the key itself", () => {
  const lines = appEnvLines({ id: 7, slug: 'shipcast-me', client_id: 'Iv1.x', client_secret: 's', webhook_secret: 'w' }, 'data/github-app.pem');
  assert.match(lines, /^SHIPCAST_GITHUB_APP_ID=7$/m);
  assert.match(lines, /^SHIPCAST_GITHUB_APP_PRIVATE_KEY_FILE=data\/github-app\.pem$/m);
  assert.doesNotMatch(lines, /BEGIN/);
});

test('an existing install is never overwritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shipcast-init-'));
  const env = join(dir, '.env');
  assert.equal(refuseExisting(env), undefined, 'no .env: go ahead');
  writeFileSync(env, '# a copy of .env.example\nSHIPCAST_GITHUB_APP_ID=\n');
  assert.equal(refuseExisting(env), undefined, 'an untouched template is not an install');
  writeFileSync(env, 'SHIPCAST_DATABASE_URL=postgres://x\n');
  assert.match(refuseExisting(env) ?? '', /never overwrites/);
});

test('the flags are checked before anything is written', () => {
  assert.deepEqual(parseInitArgs(['--login', 'yeyo11', '--public-url', 'https://a.dev/', '--yes']), {
    publicUrl: 'https://a.dev',
    login: 'yeyo11',
    skipDocker: false,
    skipGitHubApp: false,
    yes: true,
  });
  assert.match((parseInitArgs(['--public-url', 'http://a.dev']) as { error: string }).error, /https/);
  assert.match((parseInitArgs(['--login', 'not a login']) as { error: string }).error, /login/);
  assert.match((parseInitArgs(['--nope']) as { error: string }).error, /unknown flag/);
});
