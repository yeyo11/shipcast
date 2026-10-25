import { activeChannels, hasDemo, LIMITS, type Brand, type Channel, type LaunchConfig, type PackKind } from '@shipcast/schema';
import type { Launch } from './registry.ts';

/** Tools the analysis may use: reading the code and its history, never changing or running it. */
export const ANALYSIS_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(ls:*)', 'Bash(git log:*)', 'Bash(git tag:*)', 'Bash(git show:*)'];

/*
 * The prompts come in two kinds. The editable ones (each channel's brief, the brief of each kind of
 * pack, the article's) are templates the owner may rewrite in the AI settings, versioned there, with
 * the defaults below kept in code. The locked ones (the rules that keep generated text true to the
 * code, and the lines that bind the answer to the pack's schema) are never stored and never read from
 * the settings: whatever an edited prompt says, they are appended after it, unchanged.
 */

/** The channels that get a piece of their own; LinkedIn and X have no brief yet */
export const BRIEFED_CHANNELS = [
  'blog',
  'devto',
  'bluesky',
  'mastodon',
  'instagram',
  'reddit',
  'hashnode',
  'telegram',
  'discord',
  'hackerNews',
  'productHunt',
  'newsletter',
] as const satisfies readonly Channel[];

export type PromptId = `channel.${(typeof BRIEFED_CHANNELS)[number]}` | `pack.${PackKind}` | 'article';

/** Every editable prompt, by id, as the code ships it */
export const DEFAULT_PROMPTS: Readonly<Record<PromptId, string>> = {
  'pack.launch':
    'This is the project’s first launch. The article is a full introduction: the problem, the solution, how it works, a quick start with the real commands, and what comes next.',
  'pack.major':
    'This is a major version of a project that has launched before. The article explains what is new and what changed for people already using it; it does not reintroduce the whole project.',
  'pack.minor': 'This is a minor version. Prefer improved release notes; social posts stay short and only mention what a user would notice.',
  'channel.blog':
    "article: the canonical post, one version per language ({{blogLanguages}}). Each version has its own slug, written in its language's words (the English one in English, the Spanish one in Spanish), and lives at {{site}}/<lang>/<that slug>/. Markdown body without front matter and without a top-level heading. Description at most {{limit.articleDescription}} characters.",
  'channel.devto':
    'devto: 1 to {{limit.devtoTags}} lowercase tags. dev.to republishes the English article with the blog as canonical URL, so write nothing else for it.',
  'channel.bluesky':
    "bluesky: one post in English, at most {{limit.blueskyGraphemes}} characters, ending with the English article's link {{site}}/en/<English slug>/?ref=bluesky.",
  'channel.mastodon':
    "mastodon: one post in English, at most {{limit.mastodonCharacters}} characters, ending with the English article's link {{site}}/en/<English slug>/?ref=mastodon, and a few hashtags (Mastodon search relies on them).",
  'channel.instagram':
    'instagram: a carousel in English{{demoNote}}. A summary of one line for the cover (at most {{limit.instagramSummary}} characters); 2 or 3 slides, each one implemented feature with a short title (at most {{limit.instagramSlideTitle}} characters) and one concrete sentence (at most {{limit.instagramSlideText}}); and a short caption: a one-line hook, two or three lines on what it is, "link in bio" (links are not clickable there, so no URL), and at most {{limit.instagramHashtags}} specific hashtags, never generic ones.',
  'channel.reddit':
    'reddit: {{redditTarget}}. Write each for that community: what was built and why, plain and honest, never an ad. Link the article with ?ref=reddit. The owner posts these by hand.',
  'channel.hashnode':
    'hashnode: 1 to {{limit.hashnodeTags}} lowercase tags (letters and digits only). Hashnode republishes the English article with the blog as the original URL, so write nothing else for it.',
  'channel.telegram':
    "telegram: one post in English, at most {{limit.telegramText}} characters (it is the caption of the launch image), ending with the English article's link {{site}}/en/<English slug>/?ref=telegram.",
  'channel.discord':
    "discord: one message in English, at most {{limit.discordText}} characters, ending with the English article's link {{site}}/en/<English slug>/?ref=discord. Short paragraphs; Discord renders Markdown.",
  'channel.hackerNews':
    'hackerNews: a Show HN draft. A title starting with "Show HN: ", at most {{limit.hackerNewsTitle}} characters in all, plain and without hype; and the author\'s first comment (at most {{limit.hackerNewsComment}} characters, plain text): what it is, why you built it, how it works in a few lines, and what comes next. Honest about what exists today. The URL submitted is the repository, so do not link the article. The owner posts it by hand.',
  'channel.productHunt':
    "productHunt: a tagline (at most {{limit.productHuntTagline}} characters), a description (at most {{limit.productHuntDescription}}) and the maker's first comment (at most {{limit.productHuntComment}}): who made it, why, what it does today. Concrete, no superlatives. The owner posts it by hand.",
  'channel.newsletter':
    "newsletter: one issue per language ({{newsletterLanguages}}), each with a subject (at most {{limit.newsletterSubject}} characters), a preview text (at most {{limit.newsletterPreview}}) and a short Markdown body: a personal note to subscribers on what shipped and why it matters, linking the article in that language ({{site}}/<lang>/<that language's slug>/?ref=newsletter). Not the article itself; no images.",
  article:
    "Translate it faithfully into {{otherLanguages}} as the other version(s), each with its own title, description and slug in that language. Keep the author's voice and every link; translate nothing else into it.",
};

export const PROMPT_IDS = Object.keys(DEFAULT_PROMPTS) as PromptId[];

export function isPromptId(id: string): id is PromptId {
  return Object.hasOwn(DEFAULT_PROMPTS, id);
}

/** The editable prompts as the owner left them; a missing one is its default */
export type PromptTexts = Partial<Record<PromptId, string>>;

/**
 * The rules that keep a launch's pieces true to the code. Locked: shown in the settings, never
 * editable, and always the last word of the system prompt.
 */
export const LOCKED_LAUNCH_RULES: readonly string[] = [
  'The code is the source of truth, not the README. Read the code before writing. Only features you found implemented in the code may be presented as working; planned features and claims the code does not back are named as such, or left out.',
  'Never invent commands, flags, numbers, benchmarks or users. Every command you show must exist in the repository.',
  'The pieces talk about what works today. Limitations go in `analysis` for the owner to read, never into an article, a post or the newsletter: no "what does not work yet" section or line.',
  'Each channel gets its own text, written for that channel; never paste the same copy twice.',
];

/** The same for an article the owner wrote: the article is the truth, nothing is added to it */
export const LOCKED_ARTICLE_RULES: readonly string[] = [
  'The article is the source of truth: every piece says only what the article says. Never add claims, numbers, features or links it does not contain.',
  'Each channel gets its own text, written for that channel; never paste the same copy twice.',
];

const DEFAULT_TONE = 'first person, direct and technical, no hype.';

/** The variables a template may use, for this brand and launch */
export function promptVariables(brand: Brand, config: LaunchConfig, extra: Record<string, string> = {}): Record<string, string> {
  const subs = config.reddit.subreddits;
  return {
    site: brand.site,
    blogLanguages: brand.languages.blog.join(' and '),
    newsletterLanguages: Object.keys(brand.newsletter?.lists ?? { en: 1 }).join(' and '),
    redditTarget: subs.length > 0 ? `one draft for each of r/${subs.join(', r/')}` : 'one or two drafts, suggesting fitting subreddits',
    demoNote: hasDemo(config) ? ' (the demo plays as its second slide)' : '',
    otherLanguages: 'the other blog languages',
    ...Object.fromEntries(Object.entries(LIMITS).map(([key, value]) => [`limit.${key}`, String(value)])),
    ...extra,
  };
}

/** Every name a template may use, so the settings can refuse a typo before it reaches a prompt */
export const PROMPT_VARIABLES: readonly string[] = [
  'site',
  'blogLanguages',
  'newsletterLanguages',
  'redditTarget',
  'demoNote',
  'otherLanguages',
  ...Object.keys(LIMITS).map((key) => `limit.${key}`),
];

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

export function renderTemplate(text: string, variables: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => variables[name] ?? whole);
}

/** What is wrong with an edited prompt: placeholders that do not exist, or nothing at all */
export function templateProblems(text: string): string[] {
  const problems: string[] = [];
  if (!text.trim()) problems.push('a prompt cannot be empty; restore the default instead');
  for (const [, name] of text.matchAll(PLACEHOLDER)) {
    if (name && !PROMPT_VARIABLES.includes(name)) problems.push(`{{${name}}} is not a variable (${PROMPT_VARIABLES.slice(0, 6).join(', ')}, limit.…)`);
  }
  return problems;
}

function text(id: PromptId, prompts: PromptTexts): string {
  return prompts[id] ?? DEFAULT_PROMPTS[id];
}

/** What each channel's piece must be, in the prompt's words; undefined for a channel with no brief. */
export function channelBrief(channel: Channel, brand: Brand, config: LaunchConfig, prompts: PromptTexts = {}, extra: Record<string, string> = {}): string | undefined {
  const id = `channel.${channel}`;
  if (!isPromptId(id)) return undefined;
  return renderTemplate(text(id, prompts), promptVariables(brand, config, extra));
}

/** The editable side of a generation: the owner's prompts and, when set, a tone that replaces brand.yml's */
export interface PromptOptions {
  prompts?: PromptTexts;
  tone?: string;
}

export interface Prompt {
  prompt: string;
  /** The standing rules, appended to the provider's system prompt */
  system: string;
}

/** Who writes and how: the brand, then the tone (the settings' override, else brand.yml's) */
function voice(intro: string, brand: Brand, tone: string | undefined): string[] {
  const how = tone?.trim() || brand.tone;
  return [intro, how ? `How to write: ${how}` : `How to write: ${DEFAULT_TONE}`];
}

export function briefs(channels: readonly Channel[], brand: Brand, config: LaunchConfig, prompts: PromptTexts, extra: Record<string, string> = {}): string {
  return channels
    .map((c) => channelBrief(c, brand, config, prompts, extra))
    .filter((p): p is string => p !== undefined)
    .map((p) => `- ${p}`)
    .join('\n');
}

/**
 * The instructions for one launch. The JSON Schema travels separately (the provider enforces it);
 * this text says what to read, what is true, and what each channel needs.
 */
export function buildPrompt(launch: Launch, config: LaunchConfig, brand: Brand, options: PromptOptions = {}): Prompt {
  const prompts = options.prompts ?? {};
  const system = [...voice(`You write the launch announcements of ${brand.displayName}'s open-source projects, published under their name.`, brand, options.tone), ...LOCKED_LAUNCH_RULES].join('\n');

  const prompt = [
    `Launch ${launch.repo} at ${launch.ref}. The repository is checked out in the current directory at that ref.`,
    renderTemplate(text(`pack.${launch.kind}`, prompts), promptVariables(brand, config)),
    '',
    'First fill `analysis` from what you read: summary, implemented (checked against the source), planned, documentedOnly (claims the code does not back), limitations.',
    '',
    'Then write these pieces:',
    briefs(activeChannels(config), brand, config, prompts),
    '',
    `Set kind to "${launch.kind}", project.repo to "https://github.com/${launch.repo}", project.version to "${launch.ref}" if it is a version, and choose short, lasting slugs, one per language in its own words (no version number unless the article is about that version).`,
    'Answer only through the structured output.',
  ].join('\n');

  return { prompt, system };
}

const LANGUAGE_NAMES: Record<string, string> = { en: 'English', es: 'Spanish' };

/**
 * The instructions for an article the owner wrote: translate it and write each channel's piece. The
 * owner's text is the truth, under the locked article rules.
 */
export function buildArticlePrompt(
  input: { title: string; markdown: string; lang: string },
  brand: Brand,
  config: LaunchConfig,
  repo: string,
  options: PromptOptions = {},
): Prompt {
  const prompts = options.prompts ?? {};
  const other = brand.languages.blog.filter((l) => l !== input.lang);
  const otherLanguages = other.map((l) => LANGUAGE_NAMES[l] ?? l).join(' and ');
  const system = [...voice(`You prepare the distribution of an article ${brand.displayName} wrote, published under their name.`, brand, options.tone), ...LOCKED_ARTICLE_RULES].join('\n');
  const channels = (Object.keys(config.publishing) as Channel[]).filter((c) => config.publishing[c] !== 'off');
  const prompt = [
    `Here is the article, written in ${LANGUAGE_NAMES[input.lang] ?? input.lang}.`,
    '',
    `Title: ${input.title}`,
    '',
    input.markdown.trim(),
    '',
    '---',
    '',
    'Fill `analysis` briefly: summary is the article in one sentence; implemented, planned, documentedOnly and limitations are empty lists.',
    `In \`article\`, the ${input.lang} version is the article above with its title (copy them; they are replaced by the owner's text anyway) and a description and slug in that language.`,
    other.length > 0 ? renderTemplate(text('article', prompts), promptVariables(brand, config, { otherLanguages })) : '',
    '',
    'Then write these pieces:',
    briefs(channels, brand, config, prompts),
    '',
    `Set kind to "launch" and project to { name: the article's title, repo: "https://github.com/${repo}" }. Answer only through the structured output.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
  return { prompt, system };
}
