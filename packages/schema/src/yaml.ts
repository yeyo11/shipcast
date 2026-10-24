import { LineCounter, parseDocument } from 'yaml';
import type { z } from 'zod';

/** One problem in a file a person wrote, with where to find it. */
export interface Issue {
  /** Dotted path to the offending value, `''` for the whole document */
  path: string;
  message: string;
  /** 1-based, when the value exists in the file */
  line?: number;
  column?: number;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

/**
 * Parses YAML and validates it, pointing every problem at a line. A launch.yml is edited by hand,
 * often on GitHub's web editor, so "publishing.reddit, line 14" is worth more than a stack trace.
 */
export function parseYaml<S extends z.ZodType>(text: string, schema: S): ParseResult<z.infer<S>> {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });

  if (doc.errors.length > 0) {
    return {
      ok: false,
      issues: doc.errors.map((error) => {
        const pos = lineCounter.linePos(error.pos[0]);
        return { path: '', message: error.message, line: pos.line, column: pos.col };
      }),
    };
  }

  const result = schema.safeParse(doc.toJS() ?? {});
  if (result.success) return { ok: true, value: result.data };

  return {
    ok: false,
    issues: result.error.issues.map((issue) => {
      const path = issue.path.map(String);
      // An unknown key is reported on its parent; point at the key itself when Zod names it
      const keys = issue.code === 'unrecognized_keys' ? issue.keys : [];
      const located = locate(doc, keys.length === 1 ? [...path, keys[0]!] : path, lineCounter);
      return { path: path.join('.'), message: issue.message, ...located };
    }),
  };
}

function locate(doc: ReturnType<typeof parseDocument>, path: string[], lineCounter: LineCounter) {
  // Walk up until a node exists: a missing key has no line, but its parent does
  for (let depth = path.length; depth >= 0; depth--) {
    const node = doc.getIn(path.slice(0, depth), true) as { range?: [number, number, number] } | undefined;
    if (node && typeof node === 'object' && node.range) {
      const pos = lineCounter.linePos(node.range[0]);
      return { line: pos.line, column: pos.col };
    }
  }
  return {};
}

/** `launch.yml:14:3 publishing.reddit: …`, one line per issue. */
export function formatIssues(file: string, issues: Issue[]): string {
  return issues
    .map((issue) => {
      const where = issue.line ? `${file}:${issue.line}:${issue.column ?? 1}` : file;
      return `${where} ${issue.path ? `${issue.path}: ` : ''}${issue.message}`;
    })
    .join('\n');
}
