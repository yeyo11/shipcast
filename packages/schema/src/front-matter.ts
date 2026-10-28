import { parse as parseYaml } from 'yaml';
import { splitFrontMatter } from './markdown.ts';

/** The front matter parsed and the body trimmed; a text without front matter is all body, as it is */
export function parseFrontMatter(markdown: string): { data: Record<string, unknown>; body: string } {
  const parts = splitFrontMatter(markdown);
  if (!parts) return { data: {}, body: markdown };
  return { data: (parseYaml(parts.front) as Record<string, unknown>) ?? {}, body: parts.body.trim() };
}

