import {
  CHANNELS,
  ContentPack,
  contentPackJsonSchema,
  DRAFT_ONLY_CHANNELS,
  LaunchConfig,
  missingPieces,
  type Brand,
  type Channel,
  type Language,
} from '@shipcast/schema';
import { stringify } from 'yaml';
import { launchDir, renderDrafts } from './drafts.ts';
import { buildAssets } from './launch-assets.ts';
import { deliverDrafts, readProjects, type DraftOptions, type DraftResult, type PipelineDeps } from './pipeline.ts';
import { channelBrief } from './prompt.ts';
import type { Launch } from './registry.ts';

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
 * channels on, every other channel off. Communities that only take drafts stay manual.
 */
export function articleConfig(brand: Brand, channels: Channel[]): LaunchConfig {
  const publishing = Object.fromEntries(
    CHANNELS.map((c) => [c, c === 'blog' || channels.includes(c) ? (DRAFT_ONLY_CHANNELS.includes(c) ? 'manual' : 'approval') : 'off']),
  );
  return LaunchConfig.parse({ enabled: true, brand: brand.id, publishing });
}

/** Claims an article like any launch, so the same article is never published twice */
export function claimArticle(input: ArticleInput, brand: Brand, deps: Pick<PipelineDeps, 'registry' | 'launchesRepo'>): Promise<{ claimed: boolean; launch: Launch }> {
  return deps.registry.claim({ repo: deps.launchesRepo, ref: `article:${articleSlug(input.title)}`, trigger: 'article', kind: 'launch', brand: brand.id });
}

function articlePrompt(input: ArticleInput, brand: Brand, config: LaunchConfig, repo: string): { prompt: string; system: string } {
  const other = brand.languages.blog.filter((l) => l !== input.lang);
  const pieces = (Object.keys(config.publishing) as Channel[])
    .filter((c) => config.publishing[c] !== 'off')
    .map((c) => channelBrief(c, brand, config))
    .filter((p): p is string => p !== undefined)
    .map((p) => `- ${p}`)
    .join('\n');
  const system = [
    `You prepare the distribution of an article ${brand.displayName} wrote, published under their name.`,
    brand.tone ? `How to write: ${brand.tone}` : 'How to write: first person, direct and technical, no hype.',
    'The article is the source of truth: every piece says only what the article says. Never add claims, numbers, features or links it does not contain.',
    'Each channel gets its own text, written for that channel; never paste the same copy twice.',
  ].join('\n');
  const prompt = [
    `Here is the article, written in ${input.lang === 'en' ? 'English' : 'Spanish'}.`,
    '',
    `Title: ${input.title}`,
    '',
    input.markdown.trim(),
    '',
    '---',
    '',
    `Fill \`analysis\` briefly: summary is the article in one sentence; implemented, planned, documentedOnly and limitations are empty lists.`,
    `In \`article\`, the ${input.lang} version is the article above with its title (copy them; they are replaced by the owner's text anyway) and a description and slug in that language.`,
    other.length > 0
      ? `Translate it faithfully into ${other.map((l) => (l === 'en' ? 'English' : 'Spanish')).join(' and ')} as the other version${other.length > 1 ? 's' : ''}, with ${other.length > 1 ? 'their' : 'its'} own title, description and slug in that language. Keep the author's voice and every link; translate nothing else into it.`
      : '',
    '',
    'Then write these pieces:',
    pieces,
    '',
    `Set kind to "launch" and project to { name: the article's title, repo: "https://github.com/${repo}" }. Answer only through the structured output.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
  return { prompt, system };
}

/**
 * Takes an article written in the app to its drafts: the AI translates it and writes each channel's
 * piece, the owner's words replace the AI's copy of them, the media are drawn, and the drafts go to a
 * pull request or, published directly, onto main.
 */
export async function draftArticle(launch: Launch, input: ArticleInput, brand: Brand, deps: PipelineDeps, options: DraftOptions = {}): Promise<DraftResult> {
  const { registry } = deps;
  const fail = async (problems: string[]): Promise<DraftResult> => ({ ok: false, launch: await registry.setStatus(launch.id, 'failed', problems.join('\n')), problems });
  await registry.setStatus(launch.id, 'generating');

  const config = articleConfig(brand, input.channels);
  const { prompt, system } = articlePrompt(input, brand, config, deps.launchesRepo);
  let result;
  try {
    result = await deps.ai.generate({
      prompt,
      appendSystemPrompt: system,
      cwd: deps.aiWorkdir ?? '/workspace',
      jsonSchema: contentPackJsonSchema(),
      allowedTools: [],
      maxBudgetUsd: deps.maxBudgetUsd,
    });
  } catch (error) {
    return fail([error instanceof Error ? error.message : String(error)]);
  }
  const parsed = ContentPack.safeParse(result.output);
  if (!parsed.success) return fail(parsed.error.issues.map((i) => `${i.path.join('.') || 'pack'}: ${i.message}`));

  const pack = parsed.data;
  pack.kind = 'launch';
  pack.project = { name: input.title, repo: `https://github.com/${deps.launchesRepo}` };
  const own = pack.article?.[input.lang];
  if (!pack.article || !own) return fail([`the AI returned no ${input.lang} version of the article`]);
  // The owner's words are published as they wrote them; only the other languages are the AI's
  pack.article[input.lang] = { ...own, title: input.title, markdown: input.markdown.trim() };
  const problems = missingPieces(pack, config, brand);
  if (problems.length > 0) return fail(problems);

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
    checkout: { hostPath: '', providerPath: '' },
    projects: known.projects,
    projectsText: known.text,
    fetch: deps.fetch,
  });
  if (!assets.ok) return fail([assets.problem]);

  const dir = launchDir(launch);
  const files = [
    ...renderDrafts(pack, launch, config, brand, (deps.now ?? (() => new Date()))(), assets.media.ogPng),
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
  return { ok: true, launch: delivered.launch, pullRequest: delivered.where, costUsd: result.costUsd };
}
