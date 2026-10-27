import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { build, type Plugin } from 'esbuild';
import { parse } from 'yaml';

/*
 * Builds the npm package `@yeyo11/shipcast` and, with --action, the contents of the Action's repo
 * (docs/decisions/github-action.md). The workspace packages are bundled into one ESM file, since Node
 * does not strip types under node_modules; every third-party package stays external and is declared
 * as a dependency with the range the workspace uses, so npm installs its native and WebAssembly
 * parts as usual. The files the code finds next to itself keep their relative places:
 *
 *   dist/cli/shipcast.js   the bundle (main.ts, and everything @shipcast/* it imports)
 *   dist/fonts/            packages/assets/fonts, found at ../fonts from the bundle
 *   drizzle/               the registry's migrations, found at ../../drizzle from the bundle
 *
 * Usage: node scripts/build.ts [--out <dir>] [--action <dir>]
 */

const CLI = resolve(import.meta.dirname, '..');
const ROOT = resolve(CLI, '..', '..');
const NAME = '@yeyo11/shipcast';

const { values } = parseArgs({ options: { out: { type: 'string' }, action: { type: 'string' } } });
const out = resolve(values.out ?? join(CLI, 'dist-npm'));
const version = (JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8')) as { version: string }).version;

/** Everything that is not a relative path, node: or a workspace package stays an import */
const externals: Plugin = {
  name: 'third-party-external',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith('@shipcast/')) return undefined;
      return { path: args.path, external: true };
    });
  },
};

/** `@scope/name/sub` → `@scope/name`, `name/sub` → `name` */
function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

/** The range every workspace package.json gives a dependency, refusing two different ones */
function workspaceRanges(): Map<string, string> {
  const ranges = new Map<string, string>();
  const manifests = [...readdirSync(join(ROOT, 'packages')).map((p) => join(ROOT, 'packages', p)), CLI].map((dir) => join(dir, 'package.json')).filter(existsSync);
  for (const file of manifests) {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    for (const [name, range] of Object.entries({ ...manifest.devDependencies, ...manifest.dependencies })) {
      if (range.startsWith('workspace:')) continue;
      const known = ranges.get(name);
      if (known && known !== range) throw new Error(`${name} has two ranges in the workspace: ${known} and ${range}`);
      ranges.set(name, range);
    }
  }
  return ranges;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'dist', 'cli'), { recursive: true });

const result = await build({
  entryPoints: [join(CLI, 'src', 'main.ts')],
  outfile: join(out, 'dist', 'cli', 'shipcast.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  plugins: [externals],
  define: { SHIPCAST_VERSION: JSON.stringify(version) },
  banner: { js: '#!/usr/bin/env node' },
  metafile: true,
  logLevel: 'warning',
  legalComments: 'none',
});

const imported = new Set<string>();
for (const input of Object.values(result.metafile.inputs)) {
  for (const i of input.imports) if (i.external && !i.path.startsWith('node:')) imported.add(packageOf(i.path));
}
const ranges = workspaceRanges();
const dependencies: Record<string, string> = {};
for (const name of [...imported].sort()) {
  const range = ranges.get(name);
  if (!range) throw new Error(`the bundle imports ${name}, which no workspace package.json declares`);
  dependencies[name] = range;
}

cpSync(join(ROOT, 'packages', 'assets', 'fonts'), join(out, 'dist', 'fonts'), { recursive: true });
cpSync(join(ROOT, 'packages', 'engine', 'drizzle'), join(out, 'drizzle'), { recursive: true });
cpSync(join(ROOT, 'LICENSE'), join(out, 'LICENSE'));
cpSync(join(CLI, 'README.md'), join(out, 'README.md'));

const manifest = {
  name: NAME,
  version,
  description: 'Launch your GitHub projects: on each release, the AI writes the article and the posts from the code, a pull request holds them, and merging it publishes everything, once',
  license: 'MIT',
  author: 'Jose Antonio Garrido',
  type: 'module',
  bin: { shipcast: 'dist/cli/shipcast.js' },
  files: ['dist', 'drizzle', 'README.md', 'LICENSE'],
  engines: { node: '>=24' },
  repository: { type: 'git', url: 'git+https://github.com/yeyo11/shipcast.git', directory: 'apps/cli' },
  homepage: 'https://github.com/yeyo11/shipcast#readme',
  bugs: 'https://github.com/yeyo11/shipcast/issues',
  keywords: ['launch', 'release', 'github-action', 'devto', 'bluesky', 'mastodon', 'blog', 'ai', 'claude', 'openai'],
  dependencies,
  // The workspace's security overrides (pnpm-workspace.yaml): npm honours them where this package is
  // the root project, which is the Action's install
  overrides: (parse(readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8')) as { overrides?: Record<string, string> }).overrides ?? {},
};
writeFileSync(join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built ${NAME}@${version} in ${out} (${Object.keys(dependencies).length} dependencies)`);

if (values.action) {
  const action = resolve(values.action);
  // The Action's repo keeps its own history: only the files this build owns are replaced
  for (const owned of ['dist', 'drizzle', 'templates', 'action.yml', 'README.md', 'LICENSE', 'package.json', 'package-lock.json', '.gitignore']) rmSync(join(action, owned), { recursive: true, force: true });
  mkdirSync(action, { recursive: true });
  for (const entry of ['dist', 'drizzle', 'LICENSE', 'package.json']) cpSync(join(out, entry), join(action, entry), { recursive: true });
  cpSync(join(ROOT, 'action', 'action.yml'), join(action, 'action.yml'));
  cpSync(join(ROOT, 'action', 'README.md'), join(action, 'README.md'));
  cpSync(join(ROOT, 'templates'), join(action, 'templates'), { recursive: true });
  writeFileSync(join(action, '.gitignore'), 'node_modules/\n');
  // The lockfile the Action installs from on the runner (`npm ci`): every dependency pinned
  const lock = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: action, stdio: 'inherit' });
  if (lock.status !== 0) throw new Error('npm could not write the Action’s package-lock.json');
  console.log(`Assembled the Action in ${action}`);
}
