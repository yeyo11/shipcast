import type { Language } from './channels.ts';

/** Each language's name in English, the language the prompts are written in */
export const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', es: 'Spanish' };

/** A language's name for a prompt; a code Shipcast does not know is written as it came */
export function languageName(lang: string): string {
  return (LANGUAGE_NAMES as Record<string, string>)[lang] ?? lang;
}
