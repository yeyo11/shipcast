import { execFile } from 'node:child_process';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'target', 'vendor']);
const MAX_FILE_BYTES = 200_000;
const MAX_LIST = 1000;
const MAX_MATCHES = 200;

/** Thrown for a path that leaves the checkout: the tools read the repo and nothing else on the machine */
export class OutsideRepo extends Error {}

/** A path inside the checkout, resolved through symlinks so a link cannot lead out of it */
async function inside(root: string, path: string): Promise<string> {
  const realRoot = await realpath(root);
  const target = await realpath(resolve(realRoot, path || '.'));
  const rel = relative(realRoot, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(realRoot, rel) !== target) throw new OutsideRepo(`${path} is outside the repository`);
  return target;
}

async function walk(root: string, dir: string, out: string[], limit: number): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (out.length >= limit) return;
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(root, full, out, limit);
    else if (entry.isFile()) out.push(relative(root, full));
  }
}

/**
 * Read-only tools over a checkout: list, read, search and the git history. Nothing writes, runs code
 * or reaches outside the repository; errors are returned to the model as text so it can try again.
 */
export function repoTools(root: string): ToolSet {
  const guard = async <T>(run: () => Promise<T>): Promise<T | string> => {
    try {
      return await run();
    } catch (error) {
      return `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  return {
    list_files: tool({
      description: 'Lists the files under a directory of the repository, recursively (dependencies and build output skipped).',
      inputSchema: z.object({ dir: z.string().describe('A directory relative to the repository root; "" for the root') }),
      execute: ({ dir }) =>
        guard(async () => {
          const base = await inside(root, dir);
          const files: string[] = [];
          await walk(await realpath(root), base, files, MAX_LIST);
          return files.join('\n') + (files.length >= MAX_LIST ? `\n(first ${MAX_LIST} files only)` : '');
        }),
    }),
    read_file: tool({
      description: 'Reads a text file of the repository.',
      inputSchema: z.object({ path: z.string().describe('A file path relative to the repository root') }),
      execute: ({ path }) =>
        guard(async () => {
          const file = await inside(root, path);
          const size = (await stat(file)).size;
          const text = (await readFile(file, 'utf8')).slice(0, MAX_FILE_BYTES);
          return size > MAX_FILE_BYTES ? `${text}\n(truncated: the file has ${size} bytes)` : text;
        }),
    }),
    search: tool({
      description: 'Finds the lines of the repository matching a regular expression, as path:line: text.',
      inputSchema: z.object({ pattern: z.string(), dir: z.string().optional().describe('Where to search, relative to the root; the whole repo by default') }),
      execute: ({ pattern, dir }) =>
        guard(async () => {
          const regex = new RegExp(pattern);
          const realRoot = await realpath(root);
          const files: string[] = [];
          await walk(realRoot, await inside(root, dir ?? ''), files, 5000);
          const matches: string[] = [];
          for (const file of files) {
            const full = join(realRoot, file);
            if ((await stat(full)).size > MAX_FILE_BYTES) continue;
            const lines = (await readFile(full, 'utf8')).split('\n');
            lines.forEach((line, i) => {
              if (matches.length < MAX_MATCHES && regex.test(line)) matches.push(`${file}:${i + 1}: ${line.slice(0, 300)}`);
            });
            if (matches.length >= MAX_MATCHES) break;
          }
          return matches.length > 0 ? matches.join('\n') : 'no matches';
        }),
    }),
    git_log: tool({
      description: 'The latest commits of the checked-out ref, one line each, with their tags.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).optional() }),
      execute: ({ limit }) =>
        guard(async () => (await execFileAsync('git', ['log', '--oneline', '--decorate', '-n', String(limit ?? 50)], { cwd: root })).stdout),
    }),
  };
}
