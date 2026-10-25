import { formatIssues, parseLaunchConfig } from '@shipcast/schema';
import { LAUNCH_CONFIG_PATH } from './detect.ts';

/** The reads the pre-flight check makes; `GitHubRest` implements them. */
export interface PreflightSource {
  releaseByTag(repo: string, tag: string): Promise<{ tag: string; url: string; draft: boolean } | undefined>;
  latestRelease(repo: string): Promise<{ tag: string; url: string } | undefined>;
  fileAt(repo: string, path: string, ref: string): Promise<string | undefined>;
  /** undefined when the repo has no license; `spdx` is undefined when GitHub does not recognise it */
  license(repo: string): Promise<{ spdx: string | undefined } | undefined>;
  hasReadme(repo: string, ref: string): Promise<boolean>;
  pathExists(repo: string, path: string, ref: string): Promise<boolean>;
  /** The HTTP status a URL answers to HEAD */
  head(url: string): Promise<number>;
}

export type PreflightCheckId = 'release' | 'launchYml' | 'license' | 'readme' | 'demo';

export interface PreflightCheck {
  id: PreflightCheckId;
  ok: boolean;
  required: boolean;
  /** One plain sentence a person can act on */
  detail: string;
}

export interface Preflight {
  repo: string;
  ref: string | undefined;
  /** True when every required check passes */
  ok: boolean;
  checks: PreflightCheck[];
}

/** Whether a repo is ready to launch: a release, a valid launch.yml, a license, a README and a demo. */
export async function preflight(repo: string, ref: string | undefined, deps: { github: PreflightSource }): Promise<Preflight> {
  const { github } = deps;
  const checks: PreflightCheck[] = [];

  const release = await releaseCheck(repo, ref, github);
  checks.push(release.check);
  // Without a release the files are still read, from the given ref or the default branch, so every problem shows at once
  const at = release.tag ?? ref ?? 'HEAD';

  const config = await launchYmlCheck(repo, at, github);
  checks.push(config.check);

  const license = await github.license(repo);
  checks.push(
    !license
      ? { id: 'license', ok: false, required: true, detail: 'No LICENSE file: add one so people may use the code.' }
      : !license.spdx
        ? { id: 'license', ok: false, required: true, detail: 'The LICENSE file is not one GitHub recognises: use a standard license text.' }
        : { id: 'license', ok: true, required: true, detail: `Licensed ${license.spdx}.` },
  );

  checks.push(
    (await github.hasReadme(repo, at))
      ? { id: 'readme', ok: true, required: true, detail: `README found at ${at}.` }
      : { id: 'readme', ok: false, required: true, detail: `No README at ${at}: add one that says what the project does.` },
  );

  checks.push(await demoCheck(repo, at, config.demo, config.site, github));

  return { repo, ref, ok: checks.every((c) => c.ok || !c.required), checks };
}

async function releaseCheck(repo: string, ref: string | undefined, github: PreflightSource): Promise<{ check: PreflightCheck; tag?: string }> {
  if (ref === undefined) {
    const latest = await github.latestRelease(repo);
    if (!latest) return { check: { id: 'release', ok: false, required: true, detail: `${repo} has no published release: publish one first.` } };
    return { check: { id: 'release', ok: true, required: true, detail: `Latest release is ${latest.tag}.` }, tag: latest.tag };
  }
  const found = await github.releaseByTag(repo, ref);
  if (!found) return { check: { id: 'release', ok: false, required: true, detail: `${repo} has no release tagged ${ref}: publish it first.` } };
  if (found.draft) return { check: { id: 'release', ok: false, required: true, detail: `The release ${ref} is still a draft: publish it first.` } };
  return { check: { id: 'release', ok: true, required: true, detail: `Release ${found.tag} is published.` }, tag: found.tag };
}

async function launchYmlCheck(repo: string, at: string, github: PreflightSource): Promise<{ check: PreflightCheck; demo?: string; site?: string }> {
  const fail = (detail: string) => ({ check: { id: 'launchYml' as const, ok: false, required: true, detail } });
  const text = await github.fileAt(repo, LAUNCH_CONFIG_PATH, at);
  if (text === undefined) return fail(`No ${LAUNCH_CONFIG_PATH} at ${at}: add one to say how this project launches.`);
  const parsed = parseLaunchConfig(text);
  if (!parsed.ok) return fail(`${LAUNCH_CONFIG_PATH} is invalid: ${formatIssues(LAUNCH_CONFIG_PATH, parsed.issues).replace(/\s*\n\s*/g, '; ')}`);
  // Read even when disabled, so a missing demo still shows up next to the blocking problem
  const { demo, site } = parsed.value.assets;
  if (!parsed.value.enabled) return { ...fail(`${LAUNCH_CONFIG_PATH} has enabled: false: set it to true to launch.`), demo, site };
  return { check: { id: 'launchYml', ok: true, required: true, detail: `${LAUNCH_CONFIG_PATH} is valid and enabled.` }, demo, site };
}

async function demoCheck(repo: string, at: string, demo: string | undefined, site: string | undefined, github: PreflightSource): Promise<PreflightCheck> {
  if (demo === undefined && site !== undefined) {
    const status = await github.head(site).catch(() => undefined);
    return status === 200
      ? { id: 'demo', ok: true, required: true, detail: `No assets.demo: the demo will be recorded from ${site}, which answers.` }
      : {
          id: 'demo',
          ok: false,
          required: true,
          detail: `The site ${site} ${status === undefined ? 'cannot be reached' : `answered ${status}`}: the demo is recorded from it, so fix assets.site in launch.yml.`,
        };
  }
  if (demo === undefined) {
    return { id: 'demo', ok: false, required: false, detail: 'launch.yml names no assets.demo: every launch should have a demo GIF.' };
  }
  if (/^https?:\/\//.test(demo)) {
    const status = await github.head(demo).catch(() => undefined);
    return status === 200
      ? { id: 'demo', ok: true, required: true, detail: `The demo ${demo} answers.` }
      : {
          id: 'demo',
          ok: false,
          required: true,
          detail: `The demo ${demo} ${status === undefined ? 'cannot be reached' : `answered ${status}`}: fix the URL in launch.yml.`,
        };
  }
  return (await github.pathExists(repo, demo, at))
    ? { id: 'demo', ok: true, required: true, detail: `The demo ${demo} is in the repository.` }
    : { id: 'demo', ok: false, required: true, detail: `The demo ${demo} is not in the repository at ${at}: commit it or fix the path in launch.yml.` };
}
