import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { activeChannels, parseLaunchConfig, type Brand, type ContentPack, type Language, type LaunchConfig } from '@shipcast/schema';
import type { AiProvider, ObjectRequest, ObjectResult } from './ai.ts';
import { LAUNCH_CONFIG_PATH } from './detect.ts';
import { projectSlug } from './drafts.ts';
import type { Launch } from './repositories/index.ts';

/*
 * A deterministic stand-in for the AI, for tests and for trying the GitHub Action without an API key
 * (docs/decisions/github-action.md): it writes a placeholder pack that covers every channel the
 * launch turns on, says on every piece that no model wrote it, and calls no network.
 */

/** The line every placeholder piece carries, so a fake pack can never pass for a real one */
export const FAKE_NOTICE = 'Placeholder written by Shipcast’s fake AI provider for a test: no model read the code.';

function slugOf(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}

/** The placeholder pack for a launch: valid, complete for its launch.yml, and plainly fake */
export function fakePack(launch: Launch, config: LaunchConfig, brand: Brand): ContentPack {
  const name = projectSlug(launch.repo);
  const slug = slugOf(name);
  const version = launch.ref.startsWith('public:') || launch.ref.startsWith('article:') ? undefined : launch.ref;
  const channels = new Set(activeChannels(config));
  const title = `${name}${version ? ` ${version}` : ''}`;
  const url = (lang: Language, via: string) => `${brand.site}/${lang}/${slug}-${lang === 'en' ? 'launch' : 'lanzamiento'}/?ref=${via}`;

  const languages = new Set<Language>(brand.languages.blog);
  if (channels.has('devto') || channels.has('hashnode')) languages.add('en');
  const needsArticle = channels.has('blog') || channels.has('devto') || channels.has('hashnode') || channels.has('linkedin');
  const article = needsArticle
    ? {
        tags: ['test'],
        ...Object.fromEntries(
          [...languages].map((lang) => [
            lang,
            {
              slug: `${slug}-${lang === 'en' ? 'launch' : 'lanzamiento'}`,
              title: lang === 'en' ? `${title}: a test launch` : `${title}: un lanzamiento de prueba`,
              description: FAKE_NOTICE,
              markdown: `${FAKE_NOTICE}\n\n## What is ${name}?\n\nThe project at https://github.com/${launch.repo}${version ? `, release ${version}` : ''}.\n`,
              imageAlt: `${name}, a test launch`,
            },
          ]),
        ),
      }
    : undefined;
  const lang = config.language;
  const short = `${title}: ${FAKE_NOTICE}`;

  const pack: ContentPack = {
    schemaVersion: 1,
    kind: launch.kind,
    project: { name, repo: `https://github.com/${launch.repo}`, ...(version && { version }) },
    analysis: { summary: FAKE_NOTICE, implemented: ['Nothing was read: this is a placeholder'], planned: [], documentedOnly: [], limitations: [FAKE_NOTICE] },
    ...(article && { article: article as ContentPack['article'] }),
    ...(channels.has('devto') && { devto: { tags: ['test'] } }),
    ...(channels.has('hashnode') && { hashnode: { tags: ['test'] } }),
    ...(channels.has('bluesky') && { bluesky: { lang, text: `${title} (test) ${url(lang, 'bluesky')}` } }),
    ...(channels.has('mastodon') && { mastodon: { lang, text: `${short} ${url(lang, 'mastodon')}` } }),
    ...(channels.has('telegram') && { telegram: { text: `${short} ${url('en', 'telegram')}` } }),
    ...(channels.has('discord') && { discord: { text: `${short} ${url('en', 'discord')}` } }),
    ...(channels.has('threads') && { threads: { text: `${title} (test) ${url('en', 'threads')}` } }),
    ...(channels.has('linkedin') && { linkedin: { text: short } }),
    ...(channels.has('githubDiscussions') && { githubDiscussions: { title: `${title} (test)`, body: `${FAKE_NOTICE}\n\n${url('en', 'github')}` } }),
    ...(channels.has('instagram') && {
      instagram: {
        caption: `${title}. Link in bio. #test`,
        summary: 'A test launch, written by no model',
        slides: [
          { title: 'A test', text: 'This slide is a placeholder.' },
          { title: 'No model', text: 'Nothing here was written by an AI.' },
        ],
      },
    }),
    ...(channels.has('reddit') && { reddit: config.reddit.subreddits.map((subreddit) => ({ subreddit, title: `${title} (test)`, body: FAKE_NOTICE })) }),
    ...(channels.has('newsletter') &&
      brand.newsletter && {
        newsletter: Object.fromEntries(
          Object.keys(brand.newsletter.lists).map((l) => [l, { subject: `${title} (test)`, previewText: 'A placeholder issue', markdown: FAKE_NOTICE }]),
        ) as ContentPack['newsletter'],
      }),
  };
  return pack;
}

/**
 * The fake provider for one launch: it reads launch.yml from the checkout it is handed, as the real
 * providers read the repo, and answers with `fakePack`. It streams nothing.
 */
export function fakePackProvider(launch: Launch, brand: Brand): AiProvider {
  return {
    id: 'test',
    async generateObject(request: ObjectRequest): Promise<ObjectResult> {
      if (!request.hostDir) throw new Error('the fake AI provider only writes launch packs, from a checkout');
      const parsed = parseLaunchConfig(await readFile(join(request.hostDir, LAUNCH_CONFIG_PATH), 'utf8'));
      if (!parsed.ok) throw new Error(`the fake AI provider could not read ${LAUNCH_CONFIG_PATH}`);
      return { output: fakePack(launch, parsed.value, brand), costUsd: 0 };
    },
    async *streamText(): AsyncIterable<string> {
      yield FAKE_NOTICE;
    },
  };
}
