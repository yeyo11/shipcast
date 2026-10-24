import { activeChannels, LIMITS, type Brand, type Channel, type LaunchConfig, type PackKind } from '@shipcast/schema';
import type { Launch } from './registry.ts';

/** Tools the analysis may use: reading the code and its history, never changing or running it. */
export const ANALYSIS_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(ls:*)', 'Bash(git log:*)', 'Bash(git tag:*)', 'Bash(git show:*)'];

const PACK_BRIEF: Record<PackKind, string> = {
  launch:
    'This is the project’s first launch. The article is a full introduction: the problem, the solution, how it works, a quick start with the real commands, and what comes next.',
  major:
    'This is a major version of a project that has launched before. The article explains what is new and what changed for people already using it; it does not reintroduce the whole project.',
  minor:
    'This is a minor version. Prefer improved release notes; social posts stay short and only mention what a user would notice.',
};

/** What each channel's piece must be, in the prompt's words. */
function channelBrief(channel: Channel, brand: Brand, config: LaunchConfig): string | undefined {
  const blogLangs = brand.languages.blog.join(' and ');
  switch (channel) {
    case 'blog':
      return `article: the canonical post, one version per language (${blogLangs}). Each version has its own slug, written in its language's words (the English one in English, the Spanish one in Spanish), and lives at ${brand.site}/<lang>/<that slug>/. Markdown body without front matter and without a top-level heading. Description at most ${LIMITS.articleDescription} characters.`;
    case 'devto':
      return `devto: 1 to ${LIMITS.devtoTags} lowercase tags. dev.to republishes the English article with the blog as canonical URL, so write nothing else for it.`;
    case 'bluesky':
      return `bluesky: one post in English, at most ${LIMITS.blueskyGraphemes} characters, ending with the English article's link ${brand.site}/en/<English slug>/?ref=bluesky.`;
    case 'mastodon':
      return `mastodon: one post in English, at most ${LIMITS.mastodonCharacters} characters, ending with the English article's link ${brand.site}/en/<English slug>/?ref=mastodon, and a few hashtags (Mastodon search relies on them).`;
    case 'instagram':
      return `instagram: a caption in English, at most ${LIMITS.instagramCaption} characters and ${LIMITS.instagramHashtags} hashtags, with no URL (links are not clickable there; say "link in bio"), and media "${config.assets.demo ? 'demo-video' : 'og-image'}".`;
    case 'reddit': {
      const subs = config.reddit.subreddits;
      const target = subs.length > 0 ? `one draft for each of r/${subs.join(', r/')}` : 'one or two drafts, suggesting fitting subreddits';
      return `reddit: ${target}. Write each for that community: what was built and why, plain and honest, never an ad. Link the article with ?ref=reddit. The owner posts these by hand.`;
    }
    case 'newsletter': {
      const langs = Object.keys(brand.newsletter?.lists ?? { en: 1 }).join(' and ');
      return `newsletter: one issue per language (${langs}), each with a subject (at most ${LIMITS.newsletterSubject} characters), a preview text (at most ${LIMITS.newsletterPreview}) and a short Markdown body: a personal note to subscribers on what shipped and why it matters, linking the article in that language (${brand.site}/<lang>/<that language's slug>/?ref=newsletter). Not the article itself; no images.`;
    }
    default:
      return undefined;
  }
}

export interface Prompt {
  prompt: string;
  /** The standing rules, appended to the provider's system prompt */
  system: string;
}

/**
 * The instructions for one launch. The JSON Schema travels separately (the provider enforces it);
 * this text says what to read, what is true, and what each channel needs.
 */
export function buildPrompt(launch: Launch, config: LaunchConfig, brand: Brand): Prompt {
  const pieces = activeChannels(config)
    .map((c) => channelBrief(c, brand, config))
    .filter((p): p is string => p !== undefined)
    .map((p) => `- ${p}`)
    .join('\n');

  const system = [
    `You write the launch announcements of ${brand.displayName}'s open-source projects, published under their name.`,
    brand.tone ? `How to write: ${brand.tone}` : 'How to write: first person, direct and technical, no hype.',
    'The code is the source of truth, not the README. Read the code before writing. Only features you found implemented in the code may be presented as working; planned features and claims the code does not back are named as such, or left out.',
    'Never invent commands, flags, numbers, benchmarks or users. Every command you show must exist in the repository.',
    'The pieces talk about what works today. Limitations go in `analysis` for the owner to read, never into an article, a post or the newsletter: no "what does not work yet" section or line.',
    'Each channel gets its own text, written for that channel; never paste the same copy twice.',
  ].join('\n');

  const prompt = [
    `Launch ${launch.repo} at ${launch.ref}. The repository is checked out in the current directory at that ref.`,
    PACK_BRIEF[launch.kind],
    '',
    'First fill `analysis` from what you read: summary, implemented (checked against the source), planned, documentedOnly (claims the code does not back), limitations.',
    '',
    'Then write these pieces:',
    pieces,
    '',
    `Set kind to "${launch.kind}", project.repo to "https://github.com/${launch.repo}", project.version to "${launch.ref}" if it is a version, and choose short, lasting slugs, one per language in its own words (no version number unless the article is about that version).`,
    'Answer only through the structured output.',
  ].join('\n');

  return { prompt, system };
}
