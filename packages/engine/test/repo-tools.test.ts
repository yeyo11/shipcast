import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { REPO_TOOL_LIMITS, RepoReader, repoTools } from '../src/ai/repo-tools.ts';

/*
 * The repo tools over a real git repository in a temp folder: two tagged versions, a monorepo's
 * manifests, the docs a pack reads first, and what must never be read (a symlink out, dependencies,
 * lockfiles, a file outside).
 */

let root: string;
let outside: string;

const git = (cwd: string, ...args: string[]) => gitAt(cwd, undefined, ...args);
/** At a date of its own, so the tags' order by date is not a tie */
const gitAt = (cwd: string, date: string | undefined, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'tag.gpgSign=false', '-c', 'commit.gpgSign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...(date && { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date }) },
  });

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'shipcast-repo-tools-'));
  outside = await mkdtemp(join(tmpdir(), 'shipcast-outside-'));
  await writeFile(join(outside, 'secret.txt'), 'the password is hunter2\n');
  await mkdir(join(root, 'src', 'deep'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'packages', 'core'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'dep'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Demo\n\nResolves conflicts between sessions.\n');
  await writeFile(join(root, 'CHANGELOG.md'), '# Changelog\n\n## v2\n- conflict detection\n\n## v1\n- first\n');
  await writeFile(join(root, 'docs', 'status.md'), 'Status: conflict UI is planned.\n');
  await writeFile(join(root, 'docs', 'known-limitations.md'), 'No Windows support.\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '2.0.0', scripts: { test: 'node --test', build: 'tsc' } }));
  await writeFile(join(root, 'packages', 'core', 'package.json'), JSON.stringify({ name: '@demo/core', version: '1.1.0' }));
  await writeFile(join(root, 'pnpm-lock.yaml'), 'conflict: lockfile\n');
  await writeFile(join(root, 'node_modules', 'dep', 'index.js'), 'export const conflict = true;\n');
  await writeFile(join(root, '.gitignore'), 'node_modules\nignored.txt\n');
  await writeFile(join(root, 'ignored.txt'), 'conflict in an ignored file\n');
  const main = Array.from({ length: 40 }, (_, i) => (i === 9 ? 'export function resolveConflict() {}' : i === 29 ? 'const CONFLICT_LIMIT = 3;' : `// line ${i + 1}`)).join('\n');
  await writeFile(join(root, 'src', 'main.ts'), `${main}\n`);
  await writeFile(join(root, 'src', 'deep', 'util.ts'), 'export const merge = (a: string) => a; // no conflict here\n');
  await writeFile(join(root, 'src', 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d, 0x63, 0x6f, 0x6e, 0x66]));
  await symlink(outside, join(root, 'escape'));
  await symlink(join(outside, 'secret.txt'), join(root, 'src', 'link.txt'));
  git(root, 'init', '--quiet');
  git(root, 'add', '.');
  gitAt(root, '2026-01-01T10:00:00Z', 'commit', '--quiet', '-m', 'feat: first version');
  gitAt(root, '2026-01-01T10:00:00Z', 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0', '--', 'HEAD');
  await writeFile(join(root, 'src', 'deep', 'util.ts'), 'export const merge = (a: string) => a; // no conflict here\nexport const second = 2;\n');
  gitAt(root, '2026-02-01T10:00:00Z', 'commit', '--quiet', '-am', 'feat: a second export');
  gitAt(root, '2026-02-02T10:00:00Z', 'commit', '--quiet', '--allow-empty', '-m', 'chore: nothing');
  gitAt(root, '2026-02-02T10:00:00Z', 'tag', '-a', 'v2.0.0', '-m', 'v2.0.0', '--', 'HEAD');
});

const js = () => new RepoReader(root, { rg: null });

test('read_files reads many files and ranges in one call, numbered, the range said in the header', async () => {
  const out = await js().readFiles({ files: [{ path: 'src/main.ts', from: 9, to: 11 }, { path: 'README.md' }, { path: 'src/main.ts', from: 38 }] });
  assert.match(out, /=== src\/main\.ts \(lines 9-11 of 40\) ===\n 9  \/\/ line 9\n10  export function resolveConflict\(\) \{\}\n11  \/\/ line 11/);
  assert.match(out, /=== README\.md \(3 lines\) ===\n1  # Demo/);
  assert.match(out, /=== src\/main\.ts \(lines 38-40 of 40\) ===/);
  const plain = await js().readFiles({ files: [{ path: 'README.md', to: 1 }], lineNumbers: false });
  assert.equal(plain, '=== README.md (lines 1-1 of 3) ===\n# Demo');
  assert.match(await js().readFiles({ files: [{ path: 'src/image.png' }] }), /binary file, 12 bytes: not shown/);
  assert.match(await js().readFiles({ files: [{ path: 'src' }] }), /error: not a file/);
});

test('read_files caps each file and the whole call, and says where to continue', async () => {
  const big = await mkdtemp(join(tmpdir(), 'shipcast-big-'));
  const line = 'x'.repeat(999);
  await writeFile(join(big, 'big.txt'), `${Array.from({ length: 300 }, () => line).join('\n')}\n`);
  const reader = new RepoReader(big, { rg: null });
  const one = await reader.readFiles({ files: [{ path: 'big.txt' }], lineNumbers: false });
  const shown = REPO_TOOL_LIMITS.bytesPerFile / 1000;
  assert.match(one, new RegExp(`lines 1-${shown} of 300`));
  assert.match(one, new RegExp(`\\[truncated at ${REPO_TOOL_LIMITS.bytesPerFile} bytes: shown up to line ${shown}; continue with from: ${shown + 1}\\]`));
  const many = await reader.readFiles({ files: Array.from({ length: 6 }, (_, i) => ({ path: 'big.txt', from: i * 50 + 1, to: i * 50 + 50 })).concat([{ path: 'big.txt', from: 1, to: 300 }]), lineNumbers: false });
  assert.ok(Buffer.byteLength(many) < REPO_TOOL_LIMITS.bytesPerRead + 2000, 'the call stays within its total');
  assert.match(many, /\[truncated at \d+ bytes/, 'the file that ran into the total is cut and says so');
  await assert.rejects(reader.readFiles({ files: Array.from({ length: REPO_TOOL_LIMITS.filesPerRead + 1 }, () => ({ path: 'big.txt' })) }));
});

test('nothing outside the checkout is read: ../, absolute paths and symlinks out are refused', async () => {
  const reader = js();
  const out = await reader.readFiles({ files: [{ path: '../../etc/passwd' }, { path: '/etc/passwd' }, { path: 'escape/secret.txt' }, { path: 'src/link.txt' }, { path: 'README.md' }] });
  assert.equal(out.match(/outside the repository|relative to the repository root/g)?.length, 4, out);
  assert.doesNotMatch(out, /hunter2/);
  assert.match(out, /# Demo/, 'the good path in the same call is still read');
  await assert.rejects(reader.listFiles({ path: '../' }), /outside the repository/);
  await assert.rejects(reader.search({ pattern: 'x', paths: ['escape'] }), /outside the repository/);
  await assert.rejects(reader.git({ command: 'show', ref: 'HEAD', path: '../x' }));
  await assert.rejects(reader.git({ command: 'log', range: '--output=/tmp/x' }));
  assert.doesNotMatch(await reader.search({ pattern: 'hunter2' }), /hunter2/, 'a symlinked file is not searched');
});

test('search: matches with context in grep’s shape, files mode, ignore case, globs and paths, skipping dependencies, lockfiles and ignored files', async () => {
  const reader = js();
  const content = await reader.search({ pattern: 'conflict', ignoreCase: true, context: 1 });
  assert.match(content, /^6 matches\n/);
  assert.match(content, /src\/main\.ts-9- \/\/ line 9\nsrc\/main\.ts:10: export function resolveConflict\(\) \{\}\nsrc\/main\.ts-11- \/\/ line 11\n--\nsrc\/main\.ts-29- /);
  assert.doesNotMatch(content, /node_modules|pnpm-lock|ignored\.txt/);
  assert.equal(await reader.search({ pattern: 'conflict', mode: 'files', glob: '*.md' }), '3 files, 3 matches\nCHANGELOG.md (1)\nREADME.md (1)\ndocs/status.md (1)');
  assert.equal(await reader.search({ pattern: 'conflict', mode: 'files', paths: ['src'] }), '1 files, 1 matches\nsrc/deep/util.ts (1)');
  assert.equal(await reader.search({ pattern: 'conflict', mode: 'files', glob: '!*.md', ignoreCase: true }), '2 files, 3 matches\nsrc/deep/util.ts (1)\nsrc/main.ts (2)');
  assert.match(await reader.search({ pattern: 'conflict', ignoreCase: true, maxMatches: 2 }), /^2 matches[\s\S]*\[stopped at 2 matches/);
  assert.equal(await reader.search({ pattern: 'nowhere-to-be-found' }), 'no matches');
});

test('ripgrep and the JS fallback give the same answers', async (t) => {
  const rg = process.env.SHIPCAST_TEST_RG ?? (await new RepoReader(root).rg());
  if (!rg) return t.skip('rg is not on PATH');
  const withRg = new RepoReader(root, { rg });
  const cases = [
    { pattern: 'conflict', ignoreCase: true, context: 1 },
    { pattern: 'conflict', ignoreCase: true, context: 2, paths: ['src', 'docs'] },
    { pattern: 'conflict', mode: 'files' as const, ignoreCase: true },
    { pattern: 'conflict', mode: 'files' as const, glob: '*.md' },
    { pattern: 'export (const|function)', glob: 'src/**' },
    { pattern: 'line [0-9]+', maxMatches: 5 },
    { pattern: 'nowhere-to-be-found' },
  ];
  for (const input of cases) assert.equal(await withRg.search(input), await js().search(input), JSON.stringify(input));
});

test('list_files lists tracked files filtered, and counts per directory when there are too many', async () => {
  const reader = js();
  const all = await reader.listFiles({});
  assert.match(all, /^\.: 12 files\n/);
  assert.doesNotMatch(all, /node_modules|pnpm-lock|ignored\.txt/);
  assert.equal(await reader.listFiles({ path: 'src', depth: 1 }), 'src: 4 files\nimage.png\nlink.txt\nmain.ts\n(1 more files deeper than 1 levels)');
  assert.equal(await reader.listFiles({ glob: '*.md' }), '.: 4 files\nCHANGELOG.md\nREADME.md\ndocs/known-limitations.md\ndocs/status.md');

  const wide = await mkdtemp(join(tmpdir(), 'shipcast-wide-'));
  await mkdir(join(wide, 'a'));
  await mkdir(join(wide, 'b'));
  for (let i = 0; i < REPO_TOOL_LIMITS.listed; i++) await writeFile(join(wide, 'a', `${i}.txt`), '');
  await writeFile(join(wide, 'b', 'one.txt'), '');
  await writeFile(join(wide, 'top.txt'), '');
  git(wide, 'init', '--quiet');
  git(wide, 'add', '.');
  const summary = await new RepoReader(wide, { rg: null }).listFiles({});
  assert.equal(summary, `.: ${REPO_TOOL_LIMITS.listed + 2} files, too many to list; by directory (list one with path, or narrow with glob or depth):\ntop.txt\na/ (${REPO_TOOL_LIMITS.listed} files)\nb/ (1 files)`);
});

test('git: log over a range and paths, tags newest first, show a file at a ref, diff between refs, status', async () => {
  const reader = js();
  const range = await reader.git({ command: 'log', range: 'v1.0.0..v2.0.0' });
  assert.match(range, /chore: nothing/);
  assert.match(range, /feat: a second export/);
  assert.doesNotMatch(range, /first version/);
  assert.equal((await reader.git({ command: 'log', n: 1 })).split('\n').length, 1);
  assert.match(await reader.git({ command: 'log', paths: ['src/deep/util.ts'] }), /feat: a second export[\s\S]*feat: first version/);
  assert.equal(await reader.git({ command: 'tags' }), 'v2.0.0 2026-02-02 v2.0.0\nv1.0.0 2026-01-01 v1.0.0');
  assert.equal(await reader.git({ command: 'show', ref: 'v1.0.0', path: 'src/deep/util.ts' }), 'export const merge = (a: string) => a; // no conflict here\n');
  assert.match(await reader.git({ command: 'show', ref: 'v1.0.0' }), /first version[\s\S]*README\.md/);
  assert.match(await reader.git({ command: 'diff', from: 'v1.0.0', to: 'v2.0.0' }), /src\/deep\/util\.ts \| 1 \+/);
  assert.match(await reader.git({ command: 'diff', from: 'v1.0.0', to: 'v2.0.0', path: 'src/deep/util.ts' }), /\+export const second = 2;/);
  assert.match(await reader.git({ command: 'status' }), /^## /);
  await assert.rejects(reader.git({ command: 'log', range: 'a b' }));
});

test('repo_overview gives the tree, the manifests and the first lines of the docs in one answer', async () => {
  const out = await js().overview({ lines: 10 });
  assert.match(out, /## Tree \(12 files\)\n[\s\S]*src\/ \(4 files\)/);
  assert.match(out, /Latest tags: v2\.0\.0 2026-02-02, v1\.0\.0 2026-01-01/);
  assert.match(out, /package\.json: demo@2\.0\.0\n {2}test: node --test\n {2}build: tsc/);
  assert.match(out, /packages\/core\/package\.json: @demo\/core@1\.1\.0/);
  for (const doc of ['README.md', 'CHANGELOG.md', 'docs/status.md', 'docs/known-limitations.md']) assert.match(out, new RegExp(`## ${doc.replace('.', '\\.')}\n`));
  assert.match(out, /## CHANGELOG\.md\n# Changelog\n\n## v2\n- conflict detection/);
});

test('the AI SDK tools answer with text, an invalid input as an error the model can read', async () => {
  const tools = repoTools(root, { rg: null });
  const run = (name: string, input: unknown) => tools[name]!.execute!(input as never, { toolCallId: '1', messages: [] } as never);
  assert.deepEqual(Object.keys(tools).sort(), ['git', 'list_files', 'read_files', 'repo_overview', 'search']);
  assert.match(String(await run('read_files', { files: [{ path: 'README.md' }] })), /# Demo/);
  assert.match(String(await run('git', { command: 'push' })), /^error: command:/);
  assert.match(String(await run('read_files', { files: [] })), /^error: files:/);
});
