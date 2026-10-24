import { formatIssues, parseBrand, parseLaunchConfig, resolvePack, type Brand } from '@shipcast/schema';
import type { AiProvider } from './claudio.ts';
import { LAUNCH_CONFIG_PATH } from './detect.ts';
import { launchDir, projectSlug, pullRequestBody, renderDrafts } from './drafts.ts';
import { generatePack } from './generate.ts';
import type { GitHubSource, GitHubWriter } from './github.ts';
import type { Launch, Registry } from './registry.ts';
import type { Checkout } from './workspace.ts';

export interface PipelineDeps {
  github: GitHubSource & GitHubWriter;
  ai: AiProvider;
  registry: Registry;
  /** The repo whose blog and drafts this engine writes to, e.g. `yeyo11/launches` */
  launchesRepo: string;
  /** Clones a repo at a ref into the workspace shared with the AI */
  checkout: (repo: string, ref: string) => Promise<Checkout>;
  now?: () => Date;
  maxBudgetUsd?: number;
}

/** The brand the launches repo speaks for, read from its `brand.yml` on the default branch. */
export async function loadBrand(github: GitHubSource, launchesRepo: string): Promise<Brand> {
  const text = await github.fileAt(launchesRepo, 'brand.yml', 'HEAD');
  if (text === undefined) throw new Error(`${launchesRepo} has no brand.yml`);
  const parsed = parseBrand(text);
  if (!parsed.ok) throw new Error(`${launchesRepo}/brand.yml is invalid:\n${formatIssues('brand.yml', parsed.issues)}`);
  return parsed.value;
}

export type DraftResult =
  | { ok: true; launch: Launch; pullRequest: string; costUsd: number | null }
  | { ok: false; launch: Launch; problems: string[] };

/**
 * Takes a claimed launch to its drafts pull request: reads launch.yml at the ref, clones the release,
 * generates and checks the content pack, and opens the pull request in the launches repo. The
 * registry records each step, so a failure says where it stopped and why.
 */
export async function draftLaunch(launch: Launch, brand: Brand, deps: PipelineDeps): Promise<DraftResult> {
  const { github, registry } = deps;
  const fail = (problems: string[]): DraftResult => ({
    ok: false,
    launch: registry.setStatus(launch.id, 'failed', problems.join('\n')),
    problems,
  });

  registry.setStatus(launch.id, 'generating');
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

  const generated = await generatePack({ ai: deps.ai, launch, config, brand, checkout, maxBudgetUsd: deps.maxBudgetUsd });
  if (!generated.ok) {
    return fail([...generated.problems, ...(generated.chatId ? [`claudio chat: ${generated.chatId}`] : [])]);
  }

  const files = renderDrafts(generated.pack, launch, config, brand, (deps.now ?? (() => new Date()))());
  const name = `${projectSlug(launch.repo)} ${launch.ref}`;
  let pr;
  try {
    pr = await github.openPullRequest({
      repo: deps.launchesRepo,
      branch: `launch/${launchDir(launch).slice('launches/'.length).replace('/', '-')}`,
      base: 'main',
      title: `Launch ${name}`,
      body: pullRequestBody(generated.pack, launch, config),
      message: `launch: ${name}\n\nDrafted by Shipcast from the code of ${launch.repo} at ${launch.ref}.`,
      files,
    });
  } catch (error) {
    return fail([`could not open the drafts pull request: ${error instanceof Error ? error.message : String(error)}`]);
  }

  return {
    ok: true,
    launch: registry.setStatus(launch.id, 'drafted', pr.url),
    pullRequest: pr.url,
    costUsd: generated.costUsd,
  };
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
  const kind = resolvePack(parsed.value, tag, deps.registry.lastPublishedRef(repo));
  return deps.registry.claim({ repo, ref: tag, trigger: 'manual', kind, brand: brand.id });
}
