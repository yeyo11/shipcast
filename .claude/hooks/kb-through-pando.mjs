// PreToolUse hook: a markdown file under docs/ is written through pando's kb_add_document, never with
// Write or Edit (docs/knowledge-base.md). The tool stamps the front matter (created_at kept,
// updated_at refreshed, tags merged), mirrors the file back to docs/ and indexes its wiki links; a
// plain write gets none of that. Exit 2 blocks the call and hands stderr back to Claude.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

let input = {};
try {
  const raw = readFileSync(0, 'utf8');
  input = raw.trim() ? JSON.parse(raw) : {};
} catch {
  process.exit(0);
}

const ti = input.tool_input ?? {};
const target = ti.file_path ?? ti.path;
if (!target || !target.endsWith('.md')) process.exit(0);
const file = resolve(input.cwd ?? process.cwd(), target);

// The checkout the file belongs to, not the hook's own: a session can edit a file in a worktree under
// .claude/worktrees/, and that worktree's docs/ is the one pando indexes there.
let root = dirname(file);
while (!existsSync(join(root, '.mcp.json'))) {
  const up = dirname(root);
  if (up === root) process.exit(0);
  root = up;
}

const rel = relative(join(root, 'docs'), file);
if (rel.startsWith('..') || rel.startsWith(sep)) process.exit(0);
const kbPath = rel.split(sep).join('/');

process.stderr.write(
  `docs/ is the knowledge base: write ${kbPath} through mcp__pando__kb_add_document, not ${input.tool_name}.\n` +
    `Call it with file_path "${kbPath}" (relative to docs/), the full markdown body without front matter ` +
    '(pando writes created_at, updated_at and tags itself), and a few lowercase tags. To change an existing ' +
    'document, read it (kb_get_document or Read), edit the body and send it whole: the tool keeps ' +
    'created_at, refreshes updated_at and merges the tags. End the body with a "## Related" list of [[wiki links]]. ' +
    'Do not write the file through the shell either. If the pando tools are not available, stop and tell the user ' +
    'instead of writing the file by hand.\n',
);
process.exit(2);
