import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkout, checkoutName } from '../src/index.ts';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

test('checkout names are one folder per repo and ref, safe on any filesystem', () => {
  assert.equal(checkoutName('yeyo11/claudio', 'v0.9.0'), 'yeyo11__claudio@v0.9.0');
  assert.equal(checkoutName('yeyo11/x', 'release/1 beta'), 'yeyo11__x@release_1_beta');
});

test('a release is cloned at its tag, fresh, and mapped to the provider path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shipcast-ws-'));
  try {
    const origin = join(root, 'origin');
    execFileSync('git', ['init', '--quiet', '-b', 'main', origin]);
    writeFileSync(join(origin, 'VERSION'), '0.9.0\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '--quiet', '-m', 'v0.9.0');
    git(origin, 'tag', 'v0.9.0');
    writeFileSync(join(origin, 'VERSION'), '1.0.0-dev\n');
    git(origin, 'commit', '--quiet', '-am', 'after the tag');

    const workspace = { hostDir: join(root, 'workspace'), providerDir: '/workspace/', cloneUrl: () => origin };
    const first = await checkout(workspace, 'yeyo11/claudio', 'v0.9.0');
    assert.equal(readFileSync(join(first.hostPath, 'VERSION'), 'utf8'), '0.9.0\n', 'the tag, not the branch tip');
    assert.equal(first.providerPath, '/workspace/yeyo11__claudio@v0.9.0');

    writeFileSync(join(first.hostPath, 'leftover'), 'from a previous run');
    const again = await checkout(workspace, 'yeyo11/claudio', 'v0.9.0');
    assert.equal(existsSync(join(again.hostPath, 'leftover')), false, 'every checkout starts clean');

    const head = await checkout(workspace, 'yeyo11/claudio', 'HEAD');
    assert.equal(readFileSync(join(head.hostPath, 'VERSION'), 'utf8'), '1.0.0-dev\n', 'HEAD is the default branch');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a tag that does not exist fails loudly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shipcast-ws-'));
  try {
    const origin = join(root, 'origin');
    execFileSync('git', ['init', '--quiet', '-b', 'main', origin]);
    writeFileSync(join(origin, 'a'), 'a');
    git(origin, 'add', '.');
    git(origin, 'commit', '--quiet', '-m', 'a');
    await assert.rejects(checkout({ hostDir: join(root, 'ws'), providerDir: '/workspace', cloneUrl: () => origin }, 'yeyo11/x', 'v9.9.9'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
