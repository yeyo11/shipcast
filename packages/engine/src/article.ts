import {
  AI_TASK_DEFINITIONS,
  CHANNELS,
  LaunchConfig,
  missingPieces,
  type Brand,
  type Channel,
  type ContentPack,
  type Language,
} from '@shipcast/schema';
import { stringify } from 'yaml';
import { keepPubDates, launchDir, renderDrafts, screenshotPaths } from './drafts.ts';
import { buildAssets } from './launch-assets.ts';
import { aiTextsOf, deliverDrafts, readProjects, type DraftOptions, type DraftResult, type PipelineDeps } from './pipeline.ts';
import { buildArticlePrompt } from './prompt.ts';
import type { Launch } from './repositories/index.ts';

/** An article written in the app: the owner's own words, in one language, and where it should go. */
export interface ArticleInput {
  title: string;
  /** The body in Markdown, without a top-level heading */
  markdown: string;
  lang: Language;
  /** The channels besides the blog, which always carries it */
  channels: Channel[];
}

/** `Running Claude Code as a service` → `running-claude-code-as-a-service` */
export function articleSlug(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * The publishing modes of an article, as a launch.yml would say them: the blog and the chosen
 * channels on, every other channel off. GitHub Discussions is always off: an article belongs to no repository whose community it is news to.
 */
export function articleConfig(brand: Brand, channels: Channel[]): LaunchConfig {
  const on = (c: Channel) => c === 'blog' || (channels.includes(c) && c !== 'githubDiscussions');
  const publishing = Object.fromEntries(CHANNELS.map((c) => [c, on(c) ? 'approval' : 'off']));
  return LaunchConfig.parse({ enabled: true, brand: brand.id, publishing });
}

/** Claims an article like any launch, so the same article is never published twice */
export function claimArticle(input: ArticleInput, brand: Brand, deps: Pick<PipelineDeps, 'registry' | 'launchesRepo'>): Promise<{ claimed: boolean; launch: Launch }> {
  return deps.registry.launches.claim({ repo: deps.launchesRepo, ref: `article:${articleSlug(input.title)}`, trigger: 'article', kind: 'launch', brand: brand.id });
}

/**
 * The article's content pack, and nothing else: the AI translates it and writes each channel's piece,
 * and the owner's words replace the AI's copy of them. No GitHub, no registry: what a draft and a
 * dry run share.
 */
export async function generateArticlePack(
  input: ArticleInput,
  brand: Brand,
  deps: Pick<PipelineDeps, 'aiRunner' | 'aiTexts' | 'launchesRepo'>,
): Promise<{ ok: true; pack: ContentPack; config: LaunchConfig } | { ok: false; problems: string[] }> {
  const config = articleConfig(brand, input.channels);
  let pack: ContentPack;
  try {
    // No repo: the answer validated against the pack's schema and repaired once by the runner
    const { prompt, system } = buildArticlePrompt(input, brand, config, deps.launchesRepo, await aiTextsOf(deps));
    const result = await deps.aiRunner.run(AI_TASK_DEFINITIONS.article, { system, prompt });
    pack = result.output;
  } catch (error) {
    return { ok: false, problems: [error instanceof Error ? error.message : String(error)] };
  }

  pack.kind = 'launch';
  pack.project = { name: input.title, repo: `https://github.com/${deps.launchesRepo}` };
  const own = pack.article?.[input.lang];
  if (!pack.article || !own) return { ok: false, problems: [`the AI returned no ${input.lang} version of the article`] };
  // The owner's words are published as they wrote them; only the other languages are the AI's
  pack.article[input.lang] = { ...own, title: input.title, markdown: input.markdown.trim() };
  const problems = missingPieces(pack, config, brand);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, pack, config };
}

/**
 * Takes an article written in the app to its drafts: its content pack, the media drawn, and the
 * drafts to a pull request or, published directly, onto main.
 */
export async function draftArticle(launch: Launch, input: ArticleInput, brand: Brand, deps: PipelineDeps, options: DraftOptions = {}): Promise<DraftResult> {
  const { registry } = deps;
  const fail = async (problems: string[]): Promise<DraftResult> => ({ ok: false, launch: await registry.launches.setStatus(launch.id, 'failed', problems.join('\n')), problems });
  await registry.launches.setStatus(launch.id, 'generating');

  const generated = await generateArticlePack(input, brand, deps);
  if (!generated.ok) return fail(generated.problems);
  const { pack, config } = generated;

  let known;
  try {
    known = await readProjects(deps.github, deps.launchesRepo);
  } catch (error) {
    return fail([error instanceof Error ? error.message : String(error)]);
  }
  const assets = await buildAssets({
    pack,
    launch,
    config,
    brand,
    checkout: { hostPath: '' },
    projects: known.projects,
    projectsText: known.text,
    fetch: deps.fetch,
  });
  if (!assets.ok) return fail([assets.problem]);

  const dir = launchDir(launch);
  const now = (deps.now ?? (() => new Date()))();
  const files = [
    ...(await keepPubDates(renderDrafts(pack, launch, config, brand, now, assets.media.ogPng, screenshotPaths(assets.files)), deps.github, deps.launchesRepo, now)),
    ...assets.files,
    { path: `${dir}/launch.yml`, content: `# The channels chosen in Shipcast for this article\n${stringify({ enabled: true, brand: brand.id, publishing: config.publishing })}` },
  ];
  const delivered = await deliverDrafts(
    launch,
    deps,
    {
      files,
      branch: `article/${dir.slice('articles/'.length)}`,
      title: `Article: ${input.title}`,
      body: `An article written in Shipcast, with its translation and a piece for each channel.\n\n**Merging publishes** the article on the blog and every \`approval\` channel. Edit any file first: what is merged is what gets published.`,
      message: `article: ${input.title}\n\nWritten in Shipcast; translated and distributed by it.`,
    },
    options,
  );
  if (!delivered.ok) return fail([delivered.problem]);
  return { ok: true, launch: delivered.launch, pullRequest: delivered.where };
}
