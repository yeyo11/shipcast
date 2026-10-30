import { formatIssues, missingPieces, parseLaunchConfig, SOURCES_PACK_TASK, type Brand, type ContentPack, type LaunchConfig } from '@shipcast/schema';
import { stringify } from 'yaml';
import { chatIdOf } from '../ai/runner.ts';
import { draftsBranch, isArticle, launchDir, projectSlug, reviewSections, type DraftFile } from '../drafts.ts';
import { aiTextsOf, deliverPack, failWith, type DraftOptions, type DraftResult, type PipelineDeps } from '../pipeline.ts';
import { buildSourcesPrompt, type PromptOptions } from '../prompt.ts';
import type { Launch, LaunchRepository, LaunchSource, LaunchSourceRepository, NewLaunchSource } from '../repositories/index.ts';
import { buildBundle, type Bundle, type BundleDeps } from './bundle.ts';
import { sourceId } from './model.ts';
import type { PageFetcher } from './pages.ts';

/*
 * Drafting a launch made from sources (launch-sources, docs/sources.md): its sources gathered into
 * one bundle, the pack asked for with every statement tied to the sources that show it, the claims
 * checked against the sources there are, and then the same render and delivery as any launch.
 */

/** What a launch made from sources is drafted with; present in PipelineDeps only with the flag on */
export interface SourcesDeps extends Omit<BundleDeps, 'freeze'> {
  store: Pick<LaunchSourceRepository, 'list' | 'replace' | 'freeze'>;
  launches: Pick<LaunchRepository, 'modelFields'>;
  /** The bundle as a gzip tarball, for a provider that reads in a workspace of its own */
  archive(hostDir: string): Promise<Uint8Array<ArrayBuffer>>;
  /** The guarded fetcher, for the pages a launch.yml names */
  fetchPage: PageFetcher;
}

/** The launch.yml text a launch with no repo publishes by: the blog and its chosen channels */
export function channelsText(config: LaunchConfig, brand: Brand): string {
  return `# The channels chosen in Shipcast for this launch\n${stringify({ enabled: true, brand: brand.id, publishing: config.publishing })}`;
}

/**
 * The sources a release brings when its launch.yml names further ones: the release itself as the
 * primary repo, each further repo at its default branch, and each page, fetched now. A page the
 * fetcher refuses fails the draft: the owner named it, so leaving it out would be a silent change.
 */
export async function releaseSources(launch: Launch, declared: NonNullable<LaunchConfig['sources']>, fetchPage: PageFetcher): Promise<NewLaunchSource[]> {
  const isPublic = launch.ref.startsWith('public:');
  const primary: NewLaunchSource = { kind: isPublic ? 'repo' : 'repo_release', role: 'primary', repo: launch.repo, ref: isPublic ? null : launch.ref };
  const repos = declared.repos
    .filter((r) => r.toLowerCase() !== launch.repo.toLowerCase())
    .map((repo): NewLaunchSource => ({ kind: 'repo', role: 'context', repo, ref: null }));
  const pages: NewLaunchSource[] = [];
  for (const url of declared.urls) {
    try {
      pages.push(await fetchPage(url));
    } catch (error) {
      throw new Error(`launch.yml's page ${url} could not be read: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return [primary, ...repos, ...pages];
}

/** What keeps a pack from being this launch's: another kind, a claim citing a source there is not, a channel left without its piece */
export function sourcesPackProblems(pack: ContentPack, launch: Launch, sources: readonly LaunchSource[], config: LaunchConfig, brand: Brand): string[] {
  const problems: string[] = [];
  if (pack.kind !== launch.kind) problems.push(`kind is "${pack.kind}", the launch is "${launch.kind}"`);
  const ids = new Set(sources.map(sourceId));
  const claims = pack.analysis.claims ?? [];
  if (claims.length === 0) problems.push('the analysis has no claims: every statement must name the sources that show it');
  for (const claim of claims) {
    const unknown = claim.sources.filter((id) => !ids.has(id));
    if (unknown.length > 0) problems.push(`the claim “${claim.text.slice(0, 80)}” cites ${unknown.join(', ')}, which this launch does not have`);
  }
  problems.push(...missingPieces(pack, config, brand));
  return problems;
}

/** The project as the sources say it, whatever the model wrote there: the primary repo, the others, the release's tag */
export function withSourceRepos(pack: ContentPack, sources: readonly LaunchSource[], launch: Launch): ContentPack {
  const repoUrl = (repo: string) => `https://github.com/${repo}`;
  const primary = sources.find((s) => s.role === 'primary' && s.repo);
  const further = sources.filter((s) => s.role !== 'primary' && s.repo).map((s) => repoUrl(s.repo!));
  const { repo: _repo, repos: _repos, version: _version, ...project } = pack.project;
  const version = primary?.kind === 'repo_release' ? launch.ref : undefined;
  return {
    ...pack,
    project: {
      ...project,
      ...(primary && { repo: repoUrl(primary.repo!) }),
      ...(further.length > 0 && { repos: further }),
      ...(version && { version }),
    },
  };
}

/** The drafts pull request's words for a launch made from sources: what it was made from, and what each claim rests on */
export function sourcesPullRequestBody(pack: ContentPack, launch: Launch, config: LaunchConfig, sources: readonly LaunchSource[], title: string): string {
  const what = (s: LaunchSource) =>
    s.kind === 'url' ? `<${s.url}>` : s.kind === 'text' ? 'the owner’s text' : s.kind === 'media' ? `a file (${String(s.meta.name ?? s.media?.mime ?? 'upload')})` : `${s.repo} at \`${s.ref ?? 'HEAD'}\`${s.sha ? ` (${s.sha.slice(0, 12)})` : ''}`;
  const intro = isArticle(launch) ? `“${title}”, a launch drafted by Shipcast from its sources (${launch.kind} pack).` : `Launch of [${launch.repo}](https://github.com/${launch.repo}) at \`${launch.ref}\` (${launch.kind} pack), drafted by Shipcast from its sources.`;
  return [
    intro,
    '',
    '### Sources',
    '',
    ...sources.map((s) => `- **${sourceId(s)}** (${s.role}): ${what(s)}`),
    '',
    '### Claims and what shows them',
    '',
    ...(pack.analysis.claims ?? []).map((c) => `- ${c.text} (${c.sources.join(', ')})`),
    '',
    ...reviewSections(pack, config),
  ].join('\n');
}

/**
 * Drafts a launch from its sources. `config` is the release's launch.yml, or undefined for a launch
 * with no repo (whose channels are kept on the launch). Answers undefined only for a release whose
 * launch has no sources and whose launch.yml names none: that one is drafted from its repo as before.
 */
export async function draftFromSources(
  launch: Launch,
  config: LaunchConfig | undefined,
  brand: Brand,
  deps: PipelineDeps & { sources: SourcesDeps },
  options: DraftOptions,
  /** The release's launch.yml as written, kept with the drafts by the launch model; a launch with no repo keeps its channels' */
  configText?: string,
): Promise<DraftResult | undefined> {
  const s = deps.sources;
  const fail = failWith(launch, deps);
  const fields = await s.launches.modelFields(launch.id);

  let effective = config;
  if (!effective) {
    const parsed = fields?.channelsSource ? parseLaunchConfig(fields.channelsSource) : undefined;
    if (!parsed) return fail(['this launch has no channels on record']);
    if (!parsed.ok) return fail([formatIssues('launch.yml', parsed.issues)]);
    effective = parsed.value;
  }

  let sources = await s.store.list(launch.id);
  if (sources.length === 0) {
    if (!config?.sources) return config ? undefined : fail(['this launch has no sources']);
    try {
      sources = await s.store.replace(launch.id, await releaseSources(launch, config.sources, s.fetchPage));
    } catch (error) {
      return fail([error instanceof Error ? error.message : String(error)]);
    }
  }

  let bundle: Bundle;
  try {
    bundle = await buildBundle(launch, sources, { folder: s.folder, clone: s.clone, freeze: (id, sha) => s.store.freeze(id, sha) });
  } catch (error) {
    return fail([`could not gather the sources: ${error instanceof Error ? error.message : String(error)}`]);
  }

  let texts: PromptOptions;
  try {
    texts = await aiTextsOf(deps);
  } catch (error) {
    return fail([`the AI settings: ${error instanceof Error ? error.message : String(error)}`]);
  }
  const title = fields?.title ?? (bundle.primary ? `${projectSlug(bundle.primary.repo)} ${launch.ref}` : launch.ref.replace(/^article:/, ''));
  const release = bundle.primary && !isArticle(launch) ? { repo: bundle.primary.repo, tag: launch.ref } : undefined;
  const { prompt, system } = buildSourcesPrompt(launch, effective, brand, { title, index: bundle.index, ...(release && { release }) }, texts);

  let pack: ContentPack;
  try {
    const result = await deps.aiRunner.run(SOURCES_PACK_TASK, {
      system,
      prompt,
      repo: { name: bundle.primary?.repo ?? `launch-${launch.id}`, ref: launch.ref, hostDir: bundle.hostDir, archive: () => s.archive(bundle.hostDir) },
    });
    pack = result.output;
    const problems = sourcesPackProblems(pack, launch, sources, effective, brand);
    const chatId = chatIdOf(result);
    if (problems.length > 0) return fail([...problems, ...(chatId ? [`claudio chat: ${chatId}`] : [])]);
  } catch (error) {
    const chatId = chatIdOf(error);
    return fail([error instanceof Error ? error.message : String(error), ...(chatId ? [`claudio chat: ${chatId}`] : [])]);
  }
  pack = withSourceRepos(pack, sources, launch);
  // Re-read: the bundle froze the commits each repo was read at
  sources = await s.store.list(launch.id);

  const dir = launchDir(launch);
  const channels = configText ?? channelsText(effective, brand);
  const extraFiles: DraftFile[] = isArticle(launch) ? [{ path: `${dir}/launch.yml`, content: channels }] : [];
  const name = isArticle(launch) ? title : `${projectSlug(launch.repo)} ${launch.ref}`;
  return deliverPack(launch, pack, effective, brand, { hostPath: bundle.primary?.hostPath ?? '' }, deps, options, {
    branch: draftsBranch(launch),
    title: isArticle(launch) ? `Launch: ${title}` : `Launch ${name}`,
    body: sourcesPullRequestBody(pack, launch, effective, sources, title),
    message: `launch: ${name}\n\nDrafted by Shipcast from ${sources.length} source${sources.length === 1 ? '' : 's'}.`,
    extraFiles,
    source: { pack, configText: channels },
  });
}
