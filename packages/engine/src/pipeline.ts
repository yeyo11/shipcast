import { formatIssues, parseBrand, parseLaunchConfig, parseProjects, PROJECTS_PATH, resolvePack, type Brand, type Projects } from '@shipcast/schema';
import type { AiProvider, AiSetup, AiTask } from './ai.ts';
import { LAUNCH_CONFIG_PATH } from './detect.ts';
import { asPublishedDirectly, launchDir, projectSlug, pullRequestBody, renderDrafts, type DraftFile } from './drafts.ts';
import { generatePack } from './generate.ts';
import type { SiteCapture } from '@shipcast/capture';
import { buildAssets } from './launch-assets.ts';
import type { GitHubSource, GitHubWriter } from './github.ts';
import type { Launch, Registry } from './registry.ts';
import type { Checkout } from './workspace.ts';

export interface PipelineDeps {
  github: GitHubSource & GitHubWriter;
  /** The provider every task falls back on when there are no AI settings to read */
  ai: AiProvider;
  /** What a task runs with, read from the AI settings each time, so an edit applies to the next draft */
  aiSetup?: (task: AiTask) => Promise<AiSetup>;
  registry: Registry;
  /** The repo whose blog and drafts this engine writes to, e.g. `yeyo11/launches` */
  launchesRepo: string;
  /** Clones a repo at a ref into the workspace shared with the AI */
  checkout: (repo: string, ref: string) => Promise<Checkout>;
  now?: () => Date;
  maxBudgetUsd?: number;
  /** For the site's covers; the global fetch by default */
  fetch?: typeof fetch;
  /** Screenshots and the tour of a project's site; headless Chromium by default */
  capture?: SiteCapture;
  /** A folder the AI provider can work in when there is no repo to clone (an article); its workspace root */
  aiWorkdir?: string;
}

/** A task's provider, model and prompts: the settings', or the default provider with the prompts in code */
export async function setupFor(deps: Pick<PipelineDeps, 'ai' | 'aiSetup'>, task: AiTask): Promise<AiSetup> {
  return deps.aiSetup ? deps.aiSetup(task) : { provider: deps.ai, prompts: {} };
}

export interface DraftOptions {
  /**
   * Skip the pull request: the drafts are committed straight onto the launches repo's main branch,
   * which publishes the blog, and the engine publishes the channels on its next round.
   */
  direct?: boolean;
}

/**
 * Hands the drafts over: a pull request to review, or, when publishing directly, one commit on main.
 * The launch records where they went (`direct:<sha>` or the pull request's URL).
 */
export async function deliverDrafts(
  launch: Launch,
  deps: PipelineDeps,
  drafts: { files: DraftFile[]; branch: string; title: string; body: string; message: string },
  options: DraftOptions,
): Promise<{ ok: true; launch: Launch; where: string } | { ok: false; problem: string }> {
  try {
    if (options.direct) {
      if (!deps.github.commitToBranch) return { ok: false, problem: 'this GitHub client cannot commit directly' };
      const commit = await deps.github.commitToBranch(deps.launchesRepo, 'main', drafts.message, asPublishedDirectly(drafts.files));
      const where = `https://github.com/${deps.launchesRepo}/commit/${commit.sha}`;
      return { ok: true, launch: await deps.registry.setStatus(launch.id, 'drafted', `direct:${commit.sha} ${where}`), where };
    }
    const pr = await deps.github.openPullRequest({ repo: deps.launchesRepo, base: 'main', ...drafts });
    return { ok: true, launch: await deps.registry.setStatus(launch.id, 'drafted', pr.url), where: pr.url };
  } catch (error) {
    const what = options.direct ? 'commit the drafts to main' : 'open the drafts pull request';
    return { ok: false, problem: `could not ${what}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The brand the launches repo speaks for, read from its `brand.yml` on the default branch. */
export async function loadBrand(github: GitHubSource, launchesRepo: string): Promise<Brand> {
  const text = await github.fileAt(launchesRepo, 'brand.yml', 'HEAD');
  if (text === undefined) throw new Error(`${launchesRepo} has no brand.yml`);
  const parsed = parseBrand(text);
  if (!parsed.ok) throw new Error(`${launchesRepo}/brand.yml is invalid:\n${formatIssues('brand.yml', parsed.issues)}`);
  return parsed.value;
}

/**
 * The brand's known projects, read from `projects.yml` on the launches repo's default branch, with
 * the file's text. A repo without one has no known projects: every look comes from the project's name.
 */
export async function readProjects(github: GitHubSource, launchesRepo: string): Promise<{ projects: Projects; text: string | undefined }> {
  const text = await github.fileAt(launchesRepo, PROJECTS_PATH, 'HEAD');
  if (text === undefined) return { projects: {}, text };
  const parsed = parseProjects(text);
  if (!parsed.ok) throw new Error(`${launchesRepo}/${PROJECTS_PATH} is invalid:\n${formatIssues(PROJECTS_PATH, parsed.issues)}`);
  return { projects: parsed.value, text };
}

export async function loadProjects(github: GitHubSource, launchesRepo: string): Promise<Projects> {
  return (await readProjects(github, launchesRepo)).projects;
}

export type DraftResult =
  | { ok: true; launch: Launch; pullRequest: string }
  | { ok: false; launch: Launch; problems: string[] };

/**
 * Takes a claimed launch to its drafts pull request: reads launch.yml at the ref, clones the release,
 * generates and checks the content pack, and opens the pull request in the launches repo. The
 * registry records each step, so a failure says where it stopped and why.
 */
export async function draftLaunch(launch: Launch, brand: Brand, deps: PipelineDeps, options: DraftOptions = {}): Promise<DraftResult> {
  const { github, registry } = deps;
  const fail = async (problems: string[]): Promise<DraftResult> => ({
    ok: false,
    launch: await registry.setStatus(launch.id, 'failed', problems.join('\n')),
    problems,
  });

  await registry.setStatus(launch.id, 'generating');
  const ref = launch.ref.startsWith('public:') ? 'HEAD' : launch.ref;

  const text = await github.fileAt(launch.repo, LAUNCH_CONFIG_PATH, ref);
  if (text === undefined) return fail([`${launch.repo} has no ${LAUNCH_CONFIG_PATH} at ${ref}`]);
  const parsed = parseLaunchConfig(text);
  if (!parsed.ok) return fail([formatIssues(LAUNCH_CONFIG_PATH, parsed.issues)]);
  const config = parsed.value;
  if (config.brand !== brand.id) return fail([`launch.yml names brand "${config.brand}"; ${deps.launchesRepo} is "${brand.id}"`]);

  let checkout: Checkout;
  try {
    checkout = await deps.checkout(launch.repo, ref);
  } catch (error) {
    return fail([`could not clone ${launch.repo} at ${ref}: ${error instanceof Error ? error.message : String(error)}`]);
  }

  let setup: AiSetup;
  try {
    setup = await setupFor(deps, 'pack');
  } catch (error) {
    return fail([`the AI settings: ${error instanceof Error ? error.message : String(error)}`]);
  }
  const generated = await generatePack({
    ai: setup.provider,
    model: setup.model,
    prompts: setup.prompts,
    tone: setup.tone,
    launch,
    config,
    brand,
    checkout,
    maxBudgetUsd: deps.maxBudgetUsd,
  });
  if (!generated.ok) {
    return fail([...generated.problems, ...(generated.chatId ? [`claudio chat: ${generated.chatId}`] : [])]);
  }

  let known;
  try {
    known = await readProjects(github, deps.launchesRepo);
  } catch (error) {
    return fail([error instanceof Error ? error.message : String(error)]);
  }
  const assets = await buildAssets({ pack: generated.pack, launch, config, brand, checkout, projects: known.projects, projectsText: known.text, fetch: deps.fetch, capture: deps.capture });
  if (!assets.ok) return fail([assets.problem]);

  const files = [
    ...renderDrafts(generated.pack, launch, config, brand, (deps.now ?? (() => new Date()))(), assets.media.ogPng),
    ...assets.files,
  ];
  const name = `${projectSlug(launch.repo)} ${launch.ref}`;
  const delivered = await deliverDrafts(
    launch,
    deps,
    {
      files,
      branch: `launch/${launchDir(launch).slice('launches/'.length).replace('/', '-')}`,
      title: `Launch ${name}`,
      body: pullRequestBody(generated.pack, launch, config),
      message: `launch: ${name}\n\nDrafted by Shipcast from the code of ${launch.repo} at ${launch.ref}.`,
    },
    options,
  );
  if (!delivered.ok) return fail([delivered.problem]);
  return { ok: true, launch: delivered.launch, pullRequest: delivered.where };
}

/**
 * A launch by hand (`shipcast launch <repo>`): the given tag or the latest release, claimed like any
 * other, so a launch started by hand is never repeated by the watcher, nor the other way round.
 */
export async function claimManual(
  repo: string,
  ref: string | undefined,
  brand: Brand,
  deps: Pick<PipelineDeps, 'github' | 'registry'>,
): Promise<{ claimed: boolean; launch: Launch } | { error: string }> {
  const tag = ref ?? (await deps.github.latestRelease(repo))?.tag;
  if (!tag) return { error: `${repo} has no published release; pass --ref <tag>` };
  const text = await deps.github.fileAt(repo, LAUNCH_CONFIG_PATH, tag);
  if (text === undefined) return { error: `${repo} has no ${LAUNCH_CONFIG_PATH} at ${tag}` };
  const parsed = parseLaunchConfig(text);
  if (!parsed.ok) return { error: formatIssues(LAUNCH_CONFIG_PATH, parsed.issues) };
  if (!parsed.value.triggers.manual) return { error: `manual launches are turned off in ${repo}'s launch.yml` };
  const kind = resolvePack(parsed.value, tag, await deps.registry.lastPublishedRef(repo));
  const claim = await deps.registry.claim({ repo, ref: tag, trigger: 'manual', kind, brand: brand.id });
  // A failed launch published nothing, so asking for it again by hand retries it; one that is drafted,
  // published or skipped stays claimed, which is what keeps a campaign from happening twice
  if (!claim.claimed && claim.launch.status === 'failed') {
    return { claimed: true, launch: await deps.registry.setStatus(claim.launch.id, 'detected', `retried after: ${claim.launch.detail?.split('\n')[0] ?? 'a failure'}`) };
  }
  return claim;
}
