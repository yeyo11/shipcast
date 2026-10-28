// Pure and import-free: the web app's client code reads it through `@shipcast/schema/markdown`,
// which keeps zod and the YAML parser out of the browser's bundle

/**
 * An article's front matter and body as written: the YAML between a first `---` line and the next,
 * and everything after it. Undefined when the text does not open with front matter; a file with CRLF
 * line ends, a leading space or an empty block (`---\n---`) has none.
 */
export function splitFrontMatter(markdown: string): { front: string; body: string } | undefined {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(markdown);
  return match ? { front: match[1]!, body: match[2]! } : undefined;
}

