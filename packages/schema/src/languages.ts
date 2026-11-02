// Free of zod, like the channels' definitions: the app's pages import it (`@shipcast/schema/languages`)
import type { Brand } from './brand.ts';

type Letter = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm' | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z';

/**
 * A language, as an ISO 639-1 code: two lowercase letters (`en`, `es`, `fr`). Any code is taken: a
 * brand's `languages.blog` says which ones its launches are written in (docs/brands.md). The type is
 * the two letters spelt out, so a pack's articles and issues keyed by language keep their own keys
 * (`tags`) apart from the languages'.
 */
export type Language = `${Letter}${Letter}`;

export const LANGUAGE_PATTERN = /^[a-z]{2}$/;

/** Whether a string is a language code: two lowercase letters */
export const isLanguage = (value: unknown): value is Language => typeof value === 'string' && LANGUAGE_PATTERN.test(value);

/**
 * Each language's name in English, the language the prompts and the app are written in: the codes a
 * brand is likely to write in. A code missing here still works everywhere; it is named by its code.
 */
export const LANGUAGE_NAMES: Partial<Record<Language, string>> = {
  ar: 'Arabic',
  ca: 'Catalan',
  cs: 'Czech',
  da: 'Danish',
  de: 'German',
  el: 'Greek',
  en: 'English',
  es: 'Spanish',
  eu: 'Basque',
  fi: 'Finnish',
  fr: 'French',
  gl: 'Galician',
  he: 'Hebrew',
  hi: 'Hindi',
  hu: 'Hungarian',
  id: 'Indonesian',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
  nb: 'Norwegian Bokmål',
  nl: 'Dutch',
  no: 'Norwegian',
  pl: 'Polish',
  pt: 'Portuguese',
  ro: 'Romanian',
  ru: 'Russian',
  sv: 'Swedish',
  th: 'Thai',
  tr: 'Turkish',
  uk: 'Ukrainian',
  vi: 'Vietnamese',
  zh: 'Chinese',
};

/** A language's name for a prompt or a label; a code Shipcast does not know is written as it came */
export function languageName(lang: string): string {
  return (LANGUAGE_NAMES as Record<string, string>)[lang] ?? lang;
}

/**
 * A draft's language, from its path in the launches repo: an article's
 * (`src/content/posts/<lang>/<slug>.md`) or a newsletter issue's (`…/newsletter-<lang>.md`).
 */
export function draftLanguage(path: string): Language | undefined {
  const match = /^src\/content\/posts\/([a-z]{2})\/[^/]+\.md$|(?:^|\/)newsletter-([a-z]{2})\.md$/.exec(path);
  return (match?.[1] ?? match?.[2]) as Language | undefined;
}

/**
 * The languages a piece's drafts are in, once each and in their order: what its language switch
 * offers. One language (or none) needs no switch.
 */
export function draftLanguages(paths: readonly string[]): Language[] {
  return [...new Set(paths.map(draftLanguage).filter((l): l is Language => l !== undefined))];
}

/**
 * The language the writing assistant translates a text in a known language into: the brand's first
 * language that is not the text's own (with English and Spanish, the other one, as it always was).
 * None for a text in the only language the brand writes in, or in no known language.
 */
export function translationTarget(lang: string | undefined, languages: readonly Language[]): Language | undefined {
  return lang === undefined ? undefined : languages.find((l) => l !== lang);
}

/** The languages a new brand writes its blog in, when its brand.yml names none */
export const DEFAULT_BLOG_LANGUAGES: readonly Language[] = ['en'];

/** The languages a pack carries for a brand: its articles', and its newsletter issues' */
export interface PackLanguages {
  /** The blog's, in the brand's order: the first is the primary language */
  blog: readonly Language[];
  /** One issue per language the newsletter has a list for; the blog's when it has none */
  newsletter: readonly Language[];
}

/** The newsletter's languages: those it has a list for, in the blog's order first */
export function newsletterLanguages(brand: Pick<Brand, 'languages' | 'newsletter'>): Language[] {
  if (!brand.newsletter) return [...brand.languages.blog];
  const listed = Object.keys(brand.newsletter.lists) as Language[];
  return [...brand.languages.blog.filter((l) => listed.includes(l)), ...listed.filter((l) => !brand.languages.blog.includes(l))];
}

export function packLanguages(brand: Pick<Brand, 'languages' | 'newsletter'>): PackLanguages {
  return { blog: [...brand.languages.blog], newsletter: newsletterLanguages(brand) };
}

/** The languages of a piece keyed by language (an article, an issue), leaving its other keys out */
export function languagesOf(piece: object | undefined): Language[] {
  return piece ? (Object.entries(piece).filter(([key, value]) => /^[a-z]{2}$/.test(key) && value !== undefined).map(([key]) => key) as Language[]) : [];
}

/**
 * The language every channel links to, and dev.to and Hashnode republish: English when the pack has
 * it, which keeps every launch made before languages were configurable as it was; otherwise the
 * first of the brand's languages the pack has (its primary one), and failing that any it has.
 */
export function leadLanguage(article: object | undefined, brand?: Pick<Brand, 'languages'>): Language | undefined {
  const present = languagesOf(article);
  if (present.includes('en')) return 'en';
  return brand?.languages.blog.find((l) => present.includes(l)) ?? present[0];
}

/**
 * The language the launch's images take the article's title from (the og image, Instagram's cover):
 * English for a brand whose blog is in English, as they always were, even where the pack lacks it
 * (the project's name stands in); otherwise the lead language.
 */
export function imageLanguage(article: object | undefined, brand: Pick<Brand, 'languages'>): Language | undefined {
  return brand.languages.blog.includes('en') ? 'en' : leadLanguage(article, brand);
}

/** The version of a piece written per language that the launch's images show (imageLanguage) */
export function imageVersion<V>(piece: { [L in Language]?: V } | undefined, brand: Pick<Brand, 'languages'>): V | undefined {
  const lang = imageLanguage(piece, brand);
  return lang ? piece?.[lang] : undefined;
}

/** What a request with a `lang` that is not a language code is told */
export const LANG_PROBLEM = 'lang is a language code: two lowercase letters (ISO 639-1), such as en';
