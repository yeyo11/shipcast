/*
 * "You were on Launches › pando v1.0.0": the page a session ended on, said in words on the sign-in
 * page. The section comes from the path; the page's own name from its title when the browser still
 * had it (the session ended while the page was open). Plain text, short, never markup.
 */
import { loginPath } from '../server/next-path.ts';

const SECTIONS: Array<[RegExp, string]> = [
  [/^\/(launches(\/|$)|launch$|sources$)/, 'Launches'],
  [/^\/write(\/|$)/, 'Write'],
  [/^\/comments(\/|$)/, 'Comments'],
  [/^\/stats(\/|$)/, 'Stats'],
  [/^\/channels(\/|$)/, 'Channels'],
  [/^\/settings(\/|$)/, 'Settings'],
  [/^\/onboarding$/, 'Set up'],
];

const MAX = 80;
const SUFFIX = /\s*·\s*Shipcast$/;

/** The section a path belongs to, when it is one of the app's */
export function sectionOf(path: string): string | undefined {
  const pathname = path.split(/[?#]/)[0] ?? '';
  return SECTIONS.find(([match]) => match.test(pathname))?.[1];
}

/**
 * The words for where the owner was: "Section › Page" when the title names a page of its own,
 * "Section" alone otherwise, or undefined when the path is not one of the app's sections.
 */
export function whereFrom(path: string, title?: string): string | undefined {
  const section = sectionOf(path);
  if (!section) return undefined;
  const page = (title ?? '').replace(SUFFIX, '').replace(/[\u0000-\u001f]/g, '').trim();
  const words = page && page !== 'Shipcast' && page.toLowerCase() !== section.toLowerCase() ? `${section} › ${page}` : section;
  return words.length > MAX ? `${words.slice(0, MAX - 1)}…` : words;
}

/** A `was` search value read back defensively: it is shown as text, so only its length is limited */
export function safeWas(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\u0000-\u001f]/g, '').trim();
  return text && text.length <= MAX ? text : undefined;
}

/**
 * The sign-in page for a session that ended on `path`: it comes back there, and says in words where
 * that was ("You were on Launches › pando"), from the page's title while the browser still has it.
 */
export function expiredPath(path: string, title: string): string {
  const login = loginPath(path);
  const was = login === '/login' ? undefined : whereFrom(path, title);
  return was ? `${login}&was=${encodeURIComponent(was)}` : login;
}
