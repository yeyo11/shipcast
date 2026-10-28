import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, open, readFile, realpath } from 'node:fs/promises';
import { basename, delimiter, isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

/*
 * Read-only tools over a job's checkout, for a provider the runner drives itself (`local-tools`).
 * Shaped after what Claude Code did on past content packs: one step read five to ten files or ranges
 * (`sed -n a,bp`, `head`, `grep -n -C`), the docs first. One call per file would take a pack 20-40
 * steps; these take many files, ranges and matches per call, and `repo_overview` is the first step
 * every past pack spent reading README, the changelog and the status. Nothing writes, runs the
 * repo's code or goes through a shell: files are read with realpath checks against the checkout, and
 * `git` and `rg` are run with execFile and fixed arguments. Errors go back to the model as text so it
 * can try again.
 */

/** Thrown for a path that leaves the checkout: the tools read the repo and nothing else on the machine */
export class OutsideRepo extends Error {}

/** Directories never read: dependencies, build output, the repository's own database */
const SKIP_DIRS = ['.git', 'node_modules', 'dist', 'build', '.next', 'target', 'vendor'];
/** Lockfiles: long, generated, and nothing in them is a claim about the project */
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'Gemfile.lock', 'composer.lock', 'go.sum', '*.lock'];

/** The ceilings of one call: big enough for a pack's reading in a few steps, small enough for one model turn */
export const REPO_TOOL_LIMITS = {
  /** Files or ranges in one read_files call */
  filesPerRead: 20,
  /** Bytes of one file's text in one read */
  bytesPerFile: 64_000,
  /** Bytes of one read_files call, every file together */
  bytesPerRead: 256_000,
  /** Matches of one search, by default and at most */
  matches: 100,
  maxMatches: 500,
  /** Lines around each match, at most */
  context: 5,
  /** Characters of one matching line */
  lineChars: 300,
  /** Bytes of a search's, a listing's or a git command's answer */
  bytesPerAnswer: 64_000,
  /** A file bigger than this is not searched */
  searchFileBytes: 1_000_000,
  /** Paths listed one by one before a listing turns into counts per directory */
  listed: 300,
  /** Commits of one git log */
  logDefault: 30,
  logMax: 200,
  /** Lines of each doc in repo_overview, by default and at most */
  overviewLines: 60,
  overviewMaxLines: 200,
} as const;

const GIT_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 16 * 1024 * 1024;

export interface RepoToolsOptions {
  /** ripgrep's path; looked up on PATH when absent, never used when null (the JS search) */
  rg?: string | null;
}

/** Paths in a directory walk's order, a directory's files after the name it shares a prefix with (ripgrep's --sort=path) */
export const byPath = (a: string, b: string): number => {
  const x = a.split('/');
  const y = b.split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return x.length - y.length;
};

const isSkipped = (rel: string): boolean => {
  const parts = rel.split('/');
  const name = parts[parts.length - 1] ?? '';
  return parts.slice(0, -1).some((p) => SKIP_DIRS.includes(p)) || LOCKFILES.some((l) => matchesGlob(name, l));
};

/** A glob as ripgrep reads it: with no slash it matches a file's name at any depth, else the path from the root */
const globMatches = (rel: string, glob: string): boolean => (glob.includes('/') ? matchesGlob(rel, glob.replace(/^\//, '')) : matchesGlob(basename(rel), glob));

/** Text cut to a byte ceiling on a character boundary */
function capBytes(text: string, bytes: number): { text: string; cut: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= bytes) return { text, cut: false };
  // Dropping a partial character at the end: decode then drop the replacement mark it may leave
  return { text: buffer.subarray(0, bytes).toString('utf8').replace(/�$/, ''), cut: true };
}

const looksBinary = (buffer: Buffer): boolean => buffer.subarray(0, 8000).includes(0);

/** The first `rg` on PATH, or null */
async function findRg(): Promise<string | null> {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, process.platform === 'win32' ? 'rg.exe' : 'rg');
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/** A ref as git takes it, refused when it could be read as an option or names something else */
const Ref = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._/@^~+{}-]+$/, 'a ref: a tag, a branch, a commit or HEAD~n')
  .refine((r) => !r.startsWith('-') && !r.includes('..'), 'a single ref');
const Range = z
  .string()
  .min(1)
  .max(400)
  .regex(/^[A-Za-z0-9._/@^~+{}-]+(\.\.\.?[A-Za-z0-9._/@^~+{}-]+)?$/, 'a ref or a range a..b')
  .refine((r) => !r.startsWith('-'), 'a ref or a range a..b');
/** A path inside the repository as git names it: relative, no way up */
const RepoPath = z
  .string()
  .min(1)
  .max(1000)
  .refine((p) => !isAbsolute(p) && !p.split(/[\\/]/).includes('..') && !p.includes('\0') && !p.startsWith('-'), 'a path relative to the repository root, inside it');

export const ReadFilesInput = z.strictObject({
  files: z
    .array(
      z.strictObject({
        path: z.string().describe('Relative to the repository root'),
        from: z.number().int().min(1).optional().describe('First line, 1-based; the start when absent'),
        to: z.number().int().min(1).optional().describe('Last line, inclusive; the end of the file (within the byte cap) when absent'),
      }),
    )
    .min(1)
    .max(REPO_TOOL_LIMITS.filesPerRead),
  lineNumbers: z.boolean().optional().describe('Prefix each line with its number (default true), handy to ask for a range next'),
});

export const SearchInput = z.strictObject({
  pattern: z.string().min(1).max(500).describe('A regular expression'),
  paths: z.array(z.string()).max(20).optional().describe('Files or directories to search, relative to the root; the whole repo by default'),
  glob: z.string().max(200).optional().describe('Only files matching it: "*.ts", "docs/**/*.md"; "!*.test.ts" excludes'),
  context: z.number().int().min(0).max(REPO_TOOL_LIMITS.context).optional().describe('Lines shown before and after each match'),
  mode: z.enum(['content', 'files']).default('content').describe('content: the matching lines; files: only the files that match, with their match counts'),
  ignoreCase: z.boolean().optional(),
  maxMatches: z.number().int().min(1).max(REPO_TOOL_LIMITS.maxMatches).optional(),
});

export const ListFilesInput = z.strictObject({
  path: z.string().optional().describe('A directory relative to the root; the root when absent'),
  glob: z.string().max(200).optional().describe('Only files matching it'),
  depth: z.number().int().min(1).max(20).optional().describe('How many directory levels below `path` to list; every level when absent'),
});

export const GitInput = z.discriminatedUnion('command', [
  z.strictObject({
    command: z.literal('log'),
    range: Range.optional().describe('A ref or a range: "v0.8.0..v0.9.0"; the checked-out commit when absent'),
    n: z.number().int().min(1).max(REPO_TOOL_LIMITS.logMax).optional(),
    paths: z.array(RepoPath).max(20).optional().describe('Only commits touching these paths'),
  }),
  z.strictObject({ command: z.literal('tags'), n: z.number().int().min(1).max(200).optional().describe('The newest n tags, by date') }),
  z.strictObject({
    command: z.literal('show'),
    ref: Ref,
    path: RepoPath.optional().describe('A file as it was at the ref; without it, the commit with its changed files'),
  }),
  z.strictObject({
    command: z.literal('diff'),
    from: Ref,
    to: Ref,
    path: RepoPath.optional().describe('The diff of this path; without it, the files changed and their line counts'),
  }),
  z.strictObject({ command: z.literal('status') }),
]);

export const OverviewInput = z.strictObject({
  lines: z.number().int().min(10).max(REPO_TOOL_LIMITS.overviewMaxLines).optional().describe(`Lines of each doc shown (default ${REPO_TOOL_LIMITS.overviewLines})`),
});

interface Hit {
  path: string;
  line: number;
  text: string;
  match: boolean;
}

/**
 * What the tools do, without the AI SDK: tested directly, and the same whatever drives it. Every
 * method answers with text for a model to read, the caps stated plainly where they cut.
 */
export class RepoReader {
  readonly #root: string;
  readonly #rgOption: string | null | undefined;
  #realRoot: Promise<string> | undefined;
  #rg: Promise<string | null> | undefined;

  constructor(root: string, options: RepoToolsOptions = {}) {
    this.#root = root;
    this.#rgOption = options.rg;
  }

  #real(): Promise<string> {
    return (this.#realRoot ??= realpath(this.#root));
  }

  /** ripgrep, when it can be used */
  rg(): Promise<string | null> {
    return (this.#rg ??= this.#rgOption !== undefined ? Promise.resolve(this.#rgOption) : findRg());
  }

  /** A path inside the checkout, resolved through symlinks so a link cannot lead out of it; returns it relative, POSIX */
  async inside(path: string): Promise<{ full: string; rel: string }> {
    if (isAbsolute(path) || path.includes('\0')) throw new OutsideRepo(`${path}: give a path relative to the repository root`);
    const root = await this.#real();
    const full = await realpath(resolve(root, path || '.'));
    const rel = relative(root, full);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new OutsideRepo(`${path} is outside the repository`);
    return { full, rel: rel.split(sep).join('/') };
  }

  async #git(args: string[], cap: number = REPO_TOOL_LIMITS.bytesPerAnswer): Promise<string> {
    // No pager, no external diff or text conversion: nothing of the repo's config runs a program
    const fixed = ['-c', 'core.pager=cat', '-c', 'core.fsmonitor=false', '--no-pager'];
    const { stdout } = await new Promise<{ stdout: string }>((done, fail) =>
      execFile('git', [...fixed, ...args], { cwd: this.#root, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }, (error, stdout, stderr) => {
        if (error) fail(new Error(`git ${args[0]}: ${(stderr || error.message).trim().slice(0, 500)}`));
        else done({ stdout });
      }),
    );
    const { text, cut } = capBytes(stdout, cap);
    return cut ? `${text}\n[truncated: the answer is over ${cap} bytes; narrow it with a path or a smaller n]` : text;
  }

  /** The repository's files, as git tracks them (plus untracked ones not ignored), sorted; dependencies, build output and lockfiles left out */
  async files(): Promise<string[]> {
    const out = await this.#git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], MAX_BUFFER);
    return [...new Set(out.split('\0').filter((f) => f && !isSkipped(f)))].sort(byPath);
  }

  async readFiles(input: z.input<typeof ReadFilesInput>): Promise<string> {
    const { files, lineNumbers = true } = ReadFilesInput.parse(input);
    let budget: number = REPO_TOOL_LIMITS.bytesPerRead;
    const parts: string[] = [];
    for (const [index, request] of files.entries()) {
      if (budget <= 0) {
        parts.push(`[not read: ${files.slice(index).map((f) => f.path).join(', ')}; this call reached its ${REPO_TOOL_LIMITS.bytesPerRead} bytes, ask for them in another call]`);
        break;
      }
      try {
        const { text, used } = await this.#readOne(request, lineNumbers, Math.min(budget, REPO_TOOL_LIMITS.bytesPerFile));
        budget -= used;
        parts.push(text);
      } catch (error) {
        parts.push(`=== ${request.path} ===\nerror: ${message(error)}`);
      }
    }
    return parts.join('\n\n');
  }

  async #readOne(request: { path: string; from?: number | undefined; to?: number | undefined }, lineNumbers: boolean, cap: number): Promise<{ text: string; used: number }> {
    const { full, rel } = await this.inside(request.path);
    if (!(await lstat(full)).isFile()) throw new Error('not a file; list_files shows what a directory holds');
    const buffer = await readFile(full);
    if (looksBinary(buffer)) return { text: `=== ${rel} ===\n(binary file, ${buffer.length} bytes: not shown)`, used: 0 };
    const lines = buffer.toString('utf8').split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const from = Math.min(request.from ?? 1, Math.max(lines.length, 1));
    const to = Math.min(request.to ?? lines.length, lines.length);
    if (to < from) return { text: `=== ${rel} (${lines.length} lines) ===\n(no lines in ${request.from}-${request.to})`, used: 0 };
    const width = String(to).length;
    const shown: string[] = [];
    let used = 0;
    let last = from - 1;
    for (let n = from; n <= to; n++) {
      const line = `${lineNumbers ? `${String(n).padStart(width)}  ` : ''}${lines[n - 1] ?? ''}`;
      const size = Buffer.byteLength(line, 'utf8') + 1;
      if (used + size > cap) break;
      shown.push(line);
      used += size;
      last = n;
    }
    const whole = from === 1 && last === lines.length;
    const header = `=== ${rel} (${whole ? `${lines.length} lines` : `lines ${from}-${last} of ${lines.length}`}) ===`;
    const note = last < to ? `\n[truncated at ${cap} bytes: shown up to line ${last}; continue with from: ${last + 1}]` : '';
    return { text: `${header}\n${shown.join('\n')}${note}`, used };
  }

  async search(input: z.input<typeof SearchInput>): Promise<string> {
    const options = SearchInput.parse(input);
    const max = options.maxMatches ?? REPO_TOOL_LIMITS.matches;
    const scopes = await Promise.all((options.paths ?? []).map(async (p) => (await this.inside(p)).rel));
    const rg = await this.rg();
    const { hits, matches, capped } = rg ? await this.#searchRg(rg, options, scopes, max) : await this.#searchJs(options, scopes, max);
    return formatHits(hits, matches, capped, max, options.mode);
  }

  /** ripgrep: its JSON events, so its answer is formatted exactly like the fallback's */
  async #searchRg(rg: string, options: z.output<typeof SearchInput>, scopes: string[], max: number): Promise<{ hits: Hit[]; matches: number; capped: boolean }> {
    const context = options.mode === 'files' ? 0 : (options.context ?? 0);
    const args = [
      '--json',
      '--no-config',
      '--hidden',
      '--sort=path',
      '--no-ignore-dot',
      '--no-ignore-global',
      '--no-ignore-parent',
      `--max-filesize=${REPO_TOOL_LIMITS.searchFileBytes}`,
      // One more than the cap, so a search that has more says it stopped
      `--max-count=${max + 1}`,
      `--context=${context}`,
      ...(options.ignoreCase ? ['--ignore-case'] : ['--case-sensitive']),
      // The caller's filter first: ripgrep gives the later globs precedence, so the exclusions win
      ...(options.glob ? [`--glob=${options.glob}`] : []),
      ...[...SKIP_DIRS, ...LOCKFILES].map((g) => `--glob=!${g}`),
      '--',
      options.pattern,
      ...(scopes.length > 0 ? scopes.map((s) => s || '.') : ['.']),
    ];
    const cwd = await this.#real();
    const stdout = await new Promise<string>((done, fail) =>
      execFile(rg, args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (error, out, stderr) => {
        // 1 is "no match"; 2 with output is a partial answer (an unreadable file), still worth giving
        const code = error && 'code' in error ? error.code : 0;
        if (!error || code === 1 || (code === 2 && out)) done(out);
        else fail(new Error(`search: ${(stderr || error.message).trim().slice(0, 500)}`));
      }),
    );
    const hits: Hit[] = [];
    let matches = 0;
    let capped = false;
    for (const raw of stdout.split('\n')) {
      if (!raw) continue;
      const event = RgEvent.safeParse(JSON.parse(raw));
      if (!event.success || (event.data.type !== 'match' && event.data.type !== 'context')) continue;
      const { path, lines, line_number } = event.data.data;
      if (path.text === undefined || lines.text === undefined || line_number === null) continue;
      const isMatch = event.data.type === 'match';
      if (isMatch && matches >= max) {
        capped = true;
        break;
      }
      if (isMatch) matches++;
      hits.push({ path: path.text.replace(/^\.\//, ''), line: line_number, text: lines.text.replace(/\r?\n$/, ''), match: isMatch });
    }
    return { hits: nearMatches(hits, context).sort((a, b) => byPath(a.path, b.path)), matches, capped };
  }

  /** The same search without ripgrep: git's file list, JavaScript's regex */
  async #searchJs(options: z.output<typeof SearchInput>, scopes: string[], max: number): Promise<{ hits: Hit[]; matches: number; capped: boolean }> {
    let regex: RegExp;
    try {
      regex = new RegExp(options.pattern, options.ignoreCase ? 'i' : '');
    } catch (error) {
      throw new Error(`search: ${message(error)}`);
    }
    const root = await this.#real();
    const context = options.mode === 'files' ? 0 : (options.context ?? 0);
    const negated = options.glob?.startsWith('!');
    const glob = negated ? options.glob!.slice(1) : options.glob;
    const files = (await this.files()).filter(
      (f) => (scopes.length === 0 || scopes.some((s) => s === '' || f === s || f.startsWith(`${s}/`))) && (glob === undefined || globMatches(f, glob) !== negated),
    );
    const hits: Hit[] = [];
    let matches = 0;
    let capped = false;
    for (const file of files) {
      const full = join(root, file);
      // Like ripgrep: a symlink is not followed, a big or binary file not searched
      const info = await lstat(full).catch(() => undefined);
      if (!info?.isFile() || info.size > REPO_TOOL_LIMITS.searchFileBytes) continue;
      const buffer = await readFile(full);
      if (looksBinary(buffer)) continue;
      const lines = buffer.toString('utf8').split('\n');
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      const fileHits = new Map<number, boolean>();
      for (const [i, line] of lines.entries()) {
        if (!regex.test(line.replace(/\r$/, ''))) continue;
        if (matches >= max) {
          capped = true;
          break;
        }
        matches++;
        fileHits.set(i, true);
        for (let c = Math.max(0, i - context); c <= Math.min(lines.length - 1, i + context); c++) if (!fileHits.has(c)) fileHits.set(c, false);
      }
      for (const [i, match] of [...fileHits.entries()].sort((a, b) => a[0] - b[0])) hits.push({ path: file, line: i + 1, text: (lines[i] ?? '').replace(/\r$/, ''), match });
      if (capped) break;
    }
    return { hits: nearMatches(hits, context), matches, capped };
  }

  async listFiles(input: z.input<typeof ListFilesInput>): Promise<string> {
    const { path, glob, depth } = ListFilesInput.parse(input);
    const { rel: base } = await this.inside(path ?? '');
    const prefix = base ? `${base}/` : '';
    const under = (await this.files()).filter((f) => f.startsWith(prefix) && (glob === undefined || globMatches(f, glob))).map((f) => f.slice(prefix.length));
    const within = depth === undefined ? under : under.filter((f) => f.split('/').length <= depth);
    const deeper = under.length - within.length;
    const label = base || '.';
    if (under.length === 0) return `${label}: no files${glob ? ` matching ${glob}` : ''}`;
    if (within.length <= REPO_TOOL_LIMITS.listed) {
      const more = deeper > 0 ? `\n(${deeper} more files deeper than ${depth} levels)` : '';
      return `${label}: ${under.length} files\n${within.join('\n')}${more}`;
    }
    // Too many to list: the files right here, and each directory with how many files it holds
    const counts = new Map<string, number>();
    const here: string[] = [];
    for (const f of under) {
      const slash = f.indexOf('/');
      if (slash < 0) here.push(f);
      else counts.set(f.slice(0, slash), (counts.get(f.slice(0, slash)) ?? 0) + 1);
    }
    const dirs = [...counts.entries()].map(([d, n]) => `${d}/ (${n} files)`);
    return `${label}: ${under.length} files, too many to list; by directory (list one with path, or narrow with glob or depth):\n${[...here, ...dirs].join('\n')}`;
  }

  async git(input: z.input<typeof GitInput>): Promise<string> {
    const command = GitInput.parse(input);
    switch (command.command) {
      case 'log': {
        const args = ['log', '--no-color', '--date=short', '--format=%h %ad%d %s', '-n', String(command.n ?? REPO_TOOL_LIMITS.logDefault), '--end-of-options'];
        const out = await this.#git([...args, command.range ?? 'HEAD', '--', ...(command.paths ?? [])]);
        return out.trim() || 'no commits';
      }
      case 'tags': {
        const out = await this.#git(['for-each-ref', '--sort=-creatordate', `--count=${command.n ?? 50}`, '--format=%(refname:short) %(creatordate:short) %(subject)', 'refs/tags']);
        return out.trim() || 'no tags (a shallow clone may have only the one it was made at)';
      }
      case 'show':
        if (command.path) return this.#git(['show', '--no-color', '--no-textconv', '--end-of-options', `${command.ref}:${command.path}`]);
        return this.#git(['show', '--no-color', '--no-ext-diff', '--stat', '--date=short', '--format=commit %H%nDate: %ad%nAuthor: %an%n%n%B', '--end-of-options', command.ref]);
      case 'diff': {
        const base = ['diff', '--no-color', '--no-ext-diff', '--no-textconv'];
        if (command.path) return (await this.#git([...base, '--end-of-options', command.from, command.to, '--', command.path])) || 'no differences';
        return (await this.#git([...base, '--stat=200', '--end-of-options', command.from, command.to])) || 'no differences';
      }
      case 'status':
        return this.#git(['status', '--short', '--branch']);
    }
  }

  /** What every past pack read first, in one answer: the tree, the manifests, the docs that say where the project is */
  async overview(input: z.input<typeof OverviewInput> = {}): Promise<string> {
    const lines = OverviewInput.parse(input).lines ?? REPO_TOOL_LIMITS.overviewLines;
    const files = await this.files();
    const sections: string[] = [];

    const top = new Map<string, number>();
    for (const f of files) {
      const slash = f.indexOf('/');
      const key = slash < 0 ? f : `${f.slice(0, slash)}/`;
      top.set(key, (top.get(key) ?? 0) + 1);
    }
    sections.push(`## Tree (${files.length} files)\n${[...top.entries()].map(([k, n]) => (k.endsWith('/') ? `${k} (${n} files)` : k)).join('\n')}`);

    const head = await this.#git(['log', '-n', '1', '--date=short', '--format=%h %ad%d %s']).catch(() => '');
    const tags = await this.#git(['for-each-ref', '--sort=-creatordate', '--count=5', '--format=%(refname:short) %(creatordate:short)', 'refs/tags']).catch(() => '');
    sections.push(`## Git\nHEAD: ${head.trim() || 'unknown'}\nLatest tags: ${tags.trim().split('\n').filter(Boolean).join(', ') || 'none'}`);

    // Manifests up to two levels down: a monorepo's packages say what it is made of
    const manifests = files.filter((f) => /(^|\/)(package\.json|Cargo\.toml|pyproject\.toml|go\.mod)$/.test(f) && f.split('/').length <= 3);
    const manifestText: string[] = [];
    for (const f of manifests.slice(0, 30)) {
      const text = await this.#text(f);
      if (text === undefined) continue;
      if (f.endsWith('package.json')) {
        try {
          const pkg = PackageJson.parse(JSON.parse(text));
          const scripts = Object.entries(pkg.scripts ?? {}).map(([k, v]) => `  ${k}: ${v}`);
          manifestText.push(`${f}: ${pkg.name ?? '(no name)'}${pkg.version ? `@${pkg.version}` : ''}${pkg.description ? ` (${pkg.description})` : ''}${scripts.length ? `\n${scripts.join('\n')}` : ''}`);
        } catch {
          manifestText.push(`${f}: not valid JSON`);
        }
      } else manifestText.push(`${f}:\n${text.split('\n').slice(0, 20).join('\n')}`);
    }
    if (manifestText.length > 0) sections.push(`## Manifests\n${manifestText.join('\n')}`);

    const docPatterns = [/^readme(\.[a-z]+)?$/i, /^changelog(\.[a-z]+)?$/i, /^roadmap(\.[a-z]+)?$/i, /^docs\/status\.md$/i, /(^|\/)known[-_]limitations(\.[a-z]+)?$/i];
    const docs = docPatterns.flatMap((p) => files.filter((f) => p.test(f)).slice(0, 2));
    for (const doc of [...new Set(docs)]) {
      const text = await this.#text(doc);
      if (text === undefined) continue;
      const all = text.split('\n');
      const shown = capBytes(all.slice(0, lines).join('\n'), 16_000).text;
      const more = all.length > lines ? `\n[first ${lines} of ${all.length} lines; read_files for the rest]` : '';
      sections.push(`## ${doc}\n${shown}${more}`);
    }
    return capBytes(sections.join('\n\n'), REPO_TOOL_LIMITS.bytesPerRead).text;
  }

  /** A text file of the listing, confined like any read, or undefined */
  async #text(rel: string): Promise<string | undefined> {
    try {
      const { full } = await this.inside(rel);
      const handle = await open(full, 'r');
      try {
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(REPO_TOOL_LIMITS.bytesPerFile), 0, REPO_TOOL_LIMITS.bytesPerFile, 0);
        const data = buffer.subarray(0, bytesRead);
        return looksBinary(data) ? undefined : data.toString('utf8');
      } finally {
        await handle.close();
      }
    } catch {
      return undefined;
    }
  }
}

const PackageJson = z.looseObject({ name: z.string().optional(), version: z.string().optional(), description: z.string().optional(), scripts: z.record(z.string(), z.string()).optional() });

const RgText = z.looseObject({ text: z.string().optional() });
const RgEvent = z.looseObject({
  type: z.string(),
  data: z.looseObject({ path: RgText.default({}), lines: RgText.default({}), line_number: z.number().nullable().default(null) }),
});

/** Only the context of the matches kept: ripgrep also gives the lines before the match past the cap */
function nearMatches(hits: Hit[], context: number): Hit[] {
  const kept = hits.filter((h) => h.match);
  return hits.filter((h) => h.match || kept.some((m) => m.path === h.path && Math.abs(m.line - h.line) <= context));
}

function formatHits(hits: Hit[], matches: number, capped: boolean, max: number, mode: 'content' | 'files'): string {
  if (matches === 0) return 'no matches';
  const note = capped ? `\n[stopped at ${max} matches: narrow the pattern, the paths or the glob, or raise maxMatches]` : '';
  if (mode === 'files') {
    const counts = new Map<string, number>();
    for (const h of hits) if (h.match) counts.set(h.path, (counts.get(h.path) ?? 0) + 1);
    return `${counts.size} files, ${matches} matches\n${[...counts.entries()].map(([p, n]) => `${p} (${n})`).join('\n')}${note}`;
  }
  // grep's own shape: path:line: for a match, path-line- for context, -- between groups that do not touch
  const out: string[] = [];
  let previous: Hit | undefined;
  for (const h of hits) {
    if (previous && (previous.path !== h.path || h.line > previous.line + 1)) out.push('--');
    const text = h.text.length > REPO_TOOL_LIMITS.lineChars ? `${h.text.slice(0, REPO_TOOL_LIMITS.lineChars)}…` : h.text;
    out.push(`${h.path}${h.match ? ':' : '-'}${h.line}${h.match ? ':' : '-'} ${text}`);
    previous = h;
  }
  const { text, cut } = capBytes(out.join('\n'), REPO_TOOL_LIMITS.bytesPerAnswer);
  return `${matches} matches\n${text}${cut ? `\n[truncated at ${REPO_TOOL_LIMITS.bytesPerAnswer} bytes: narrow the search]` : ''}${note}`;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The tool names, for whoever counts or summarises the calls */
export const REPO_TOOL_NAMES = ['repo_overview', 'read_files', 'search', 'list_files', 'git'] as const;

/**
 * The tools a `local-tools` provider reads the checkout with. The descriptions teach batching: each
 * step costs a model turn, and a turn that reads ten things is as cheap as one that reads one.
 */
export function repoTools(root: string, options: RepoToolsOptions = {}): ToolSet {
  const reader = new RepoReader(root, options);
  const guard = async (run: () => Promise<string>): Promise<string> => {
    try {
      return await run();
    } catch (error) {
      return `error: ${error instanceof z.ZodError ? error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ') : message(error)}`;
    }
  };
  return {
    repo_overview: tool({
      description:
        'Start here. In one call: the top-level tree with file counts, HEAD and the latest tags, every package manifest (name, version, scripts), and the first lines of README, CHANGELOG, ROADMAP, docs/status.md and known-limitations when present.',
      inputSchema: OverviewInput,
      execute: (input) => guard(() => reader.overview(input)),
    }),
    read_files: tool({
      description: `Reads several files, or line ranges of them, in one call (up to ${REPO_TOOL_LIMITS.filesPerRead}). Batch what you need: ask for the five files or ranges you want now rather than one per call. Use from/to for a range of a long file, like sed -n 'a,bp'; each file is capped at ${REPO_TOOL_LIMITS.bytesPerFile} bytes and the call at ${REPO_TOOL_LIMITS.bytesPerRead}, and a cut says where to continue.`,
      inputSchema: ReadFilesInput,
      execute: (input) => guard(() => reader.readFiles(input)),
    }),
    search: tool({
      description:
        'Searches the repository for a regular expression, like grep -rn: matching lines as path:line: text, with `context` lines around them, or with mode "files" only the files that match. Narrow it with paths and a glob ("*.ts", "docs/**"). Dependencies, build output and lockfiles are skipped. Search for several names at once with an alternation (a|b|c).',
      inputSchema: SearchInput,
      execute: (input) => guard(() => reader.search(input)),
    }),
    list_files: tool({
      description: `Lists the repository's tracked files under a directory, filtered by a glob and a depth. Over ${REPO_TOOL_LIMITS.listed} files it answers with counts per directory instead.`,
      inputSchema: ListFilesInput,
      execute: (input) => guard(() => reader.listFiles(input)),
    }),
    git: tool({
      description:
        'Reads the history: log (a ref or a range like v0.8.0..v0.9.0, -n, paths), tags (newest first, with dates), show (a commit with its changed files, or a file as it was at a ref), diff (between two refs: the changed files, or one path) and status. Read-only.',
      inputSchema: GitInput,
      execute: (input) => guard(() => reader.git(input)),
    }),
  };
}
