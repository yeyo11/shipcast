import { readAiSettings, writeAiSettings, AI_PROVIDERS, AI_TASKS, type AiProviderId } from '@shipcast/engine';
import { aiProviderCheck, InvalidSetting, NETWORKS, readAutomation } from '@shipcast/runtime';
import { parseBrand, formatIssues } from '@shipcast/schema';
import { createServerFn } from '@tanstack/react-start';
import { accountService, launchService, settingsService } from './app-services';
import { appContext, type AppContext } from './context.server';
import { InvalidInput, object, text } from './input';
import {
  answerTour,
  brandIssuesByField,
  checkBrandForm,
  complete,
  finish,
  initialState,
  minimalBrand,
  ONBOARDING_KEY,
  parseStep,
  readState,
  reconcile,
  setAside,
  skip,
  type BrandFieldProblems,
  type Detected,
  type OnboardingState,
} from './onboarding';

/*
 * The onboarding's server side: what is configured (detected fresh on every read), the state kept in
 * the settings, and the few actions a step needs that no other page offers (choosing the launches repo
 * from the App's installation, creating a minimal brand.yml, testing an AI provider). The rest links
 * to the flows that exist: Channels for accounts, Automation's own save. See docs/decisions/onboarding.md
 */

/** The networks that read the blog's numbers, offered by the measurement step */
export const MEASURE_NETWORKS = ['searchConsole', 'bingWebmaster', 'cloudflare'] as const;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function brandStatus(ctx: AppContext): Promise<{ ok: boolean; problem: string | null; name: string | null }> {
  if (!ctx.settings.current().launchesRepo) return { ok: false, problem: null, name: null };
  try {
    const brand = await ctx.brand();
    return { ok: true, problem: null, name: brand.displayName };
  } catch (error) {
    return { ok: false, problem: message(error), name: null };
  }
}

/** Whether a provider can be used: claudio's URL and token set, or an account connected for the others */
async function providerReady(ctx: AppContext, provider: AiProviderId): Promise<boolean> {
  if (provider === 'claudio') {
    const { claudioUrl, claudioToken } = ctx.settings.current();
    return Boolean(claudioUrl && claudioToken);
  }
  return (await accountService(ctx).list({ network: provider })).length > 0;
}

async function detect(ctx: AppContext) {
  const brand = await brandStatus(ctx);
  const ai = await readAiSettings(ctx.registry);
  const ready = Object.fromEntries(await Promise.all(AI_PROVIDERS.map(async (p) => [p, await providerReady(ctx, p)] as const))) as Record<AiProviderId, boolean>;
  const accounts = await accountService(ctx).list();
  const channelIds = new Set(NETWORKS.filter((n) => n.channel).map((n) => n.id));
  const hasLaunches = (await launchService(ctx).recent(1)).length > 0;
  const automationChosen = (await settingsService(ctx).read<string>('automation:mode')) !== undefined;
  const detected: Detected = {
    brand: brand.ok,
    ai: AI_TASKS.every((task) => ready[ai.tasks[task].provider]),
    channels: accounts.some((a) => channelIds.has(a.network)),
    measure: accounts.some((a) => (MEASURE_NETWORKS as readonly string[]).includes(a.network)),
    // An install that has launched has been running with the default mode: nothing to ask
    automation: automationChosen || hasLaunches,
  };
  return { detected, brand, ai, ready, accounts, hasLaunches };
}

async function load(ctx: AppContext, detected: Detected, hasLaunches: boolean): Promise<OnboardingState> {
  const stored = readState(await settingsService(ctx).read<unknown>(ONBOARDING_KEY));
  const state = stored ? reconcile(stored, detected) : initialState(detected, { hasLaunches });
  if (!stored || JSON.stringify(stored) !== JSON.stringify(state)) await settingsService(ctx).save(ONBOARDING_KEY, state);
  return state;
}

async function save(change: (state: OnboardingState) => OnboardingState): Promise<OnboardingState> {
  const ctx = await appContext();
  const { detected, hasLaunches } = await detect(ctx);
  const next = change(await load(ctx, detected, hasLaunches));
  await settingsService(ctx).save(ONBOARDING_KEY, next);
  return next;
}

/**
 * Just the state, for the shell, which asks on every navigation: the stored row when there is one,
 * read without detecting anything (detection reads GitHub and the keychain). Only the first sign-in,
 * with no row yet, detects what is configured and writes the first state.
 */
export const getOnboardingState = createServerFn({ method: 'GET' }).handler(async () => {
  const ctx = await appContext();
  const stored = readState(await settingsService(ctx).read<unknown>(ONBOARDING_KEY));
  if (stored) return stored;
  const { detected, hasLaunches } = await detect(ctx);
  return load(ctx, detected, hasLaunches);
});

/** Everything the onboarding's steps show */
export const getOnboarding = createServerFn({ method: 'GET' }).handler(async () => {
  const ctx = await appContext();
  const { detected, brand, ai, ready, accounts, hasLaunches } = await detect(ctx);
  const state = await load(ctx, detected, hasLaunches);
  const values = ctx.settings.current();
  const connected = (network: string) => accounts.filter((a) => a.network === network).map((a) => ({ id: a.id, label: a.identity ?? a.label, status: a.status }));
  const automation = await readAutomation(ctx.registry);
  return {
    state,
    detected,
    login: ctx.config.allowedLogins[0] ?? null,
    viaApp: Boolean(ctx.githubApp),
    brand: { launchesRepo: values.launchesRepo ?? null, ...brand },
    ai: {
      tasks: ai.tasks,
      ready,
      claudio: { url: values.claudioUrl ?? null, tokenSet: Boolean(values.claudioToken) },
    },
    channels: NETWORKS.filter((n) => n.channel).map((n) => ({ id: n.id, name: n.name, accounts: connected(n.id) })),
    measure: NETWORKS.filter((n) => (MEASURE_NETWORKS as readonly string[]).includes(n.id)).map((n) => ({ id: n.id, name: n.name, accounts: connected(n.id) })),
    automation,
  };
});

export const markStep = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = object(input, 'input');
    if (o.as !== 'done' && o.as !== 'skipped') throw new InvalidInput('as is done or skipped');
    return { step: parseStep(o.step), as: o.as as 'done' | 'skipped' };
  })
  .handler(({ data }) => save((s) => (data.as === 'done' ? complete(s, data.step) : skip(s, data.step))));

export const finishOnboarding = createServerFn({ method: 'POST' }).handler(() => save((s) => finish(s)));

export const setOnboardingAside = createServerFn({ method: 'POST' }).handler(() => save((s) => setAside(s)));

export const answerTourOffer = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (input !== 'taken' && input !== 'declined') throw new InvalidInput('the answer is taken or declined');
    return input as 'taken' | 'declined';
  })
  .handler(({ data }) => save((s) => answerTour(s, data)));

/** The repos the launches repo can be chosen from: the App's installation's, or the owner's own without an App */
export const listLaunchRepos = createServerFn({ method: 'GET' }).handler(async () => {
  const ctx = await appContext();
  try {
    if (ctx.githubApp) return { ok: true as const, repos: (await ctx.github.installationRepos()).map((r) => ({ repo: r.repo, description: r.description, private: r.private })) };
    const login = ctx.config.allowedLogins[0];
    if (!login) return { ok: false as const, problem: 'no GitHub login is allowed in .env (SHIPCAST_ALLOWED_GITHUB)' };
    return { ok: true as const, repos: (await ctx.github.userRepos(login)).map((r) => ({ repo: r.repo, description: r.description, private: false })) };
  } catch (error) {
    return { ok: false as const, problem: message(error) };
  }
});

/** What a launches repo's brand.yml says: valid, invalid with the lines, or missing */
async function readBrandFile(ctx: AppContext, repo: string) {
  const file = await ctx.github.fileAt(repo, 'brand.yml', 'HEAD');
  if (file === undefined) return { state: 'missing' as const };
  const parsed = parseBrand(file);
  return parsed.ok ? { state: 'valid' as const, name: parsed.value.displayName } : { state: 'invalid' as const, problems: formatIssues('brand.yml', parsed.issues) };
}

/** Saves the launches repo, then checks its brand.yml */
export const chooseLaunchesRepo = createServerFn({ method: 'POST' })
  .validator((input: unknown) => text(input, 'repo', 140))
  .handler(async ({ data }) => {
    const ctx = await appContext();
    try {
      await ctx.settings.write({ launchesRepo: data });
    } catch (error) {
      if (error instanceof InvalidSetting) return { ok: false as const, problem: error.message };
      throw error;
    }
    await ctx.settingsSaved('launches-repo');
    await ctx.announce('github.installation.changed', { reason: 'the launches repo changed' });
    try {
      return { ok: true as const, brand: await readBrandFile(ctx, data) };
    } catch (error) {
      return { ok: false as const, problem: `the repo is saved, but its brand.yml could not be read: ${message(error)}` };
    }
  });

function brandInput(input: unknown) {
  const o = object(input, 'input');
  const displayName = text(o.displayName, 'displayName', 120).trim();
  const site = text(o.site, 'site', 300).trim();
  const github = text(o.github, 'github', 60).trim();
  const languages = Array.isArray(o.languages) ? o.languages.filter((l): l is string => l === 'en' || l === 'es') : [];
  const id = github.toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'personal';
  return { repo: text(o.repo, 'repo', 140), id, displayName, site, github, languages };
}

type BrandFormFailure = { ok: false; problem: string; fields: BrandFieldProblems };

/**
 * The form checked with the page's rules, then the file with the schema's, every problem mapped to
 * its field in plain words; the page already checked, so this only answers a form sent around it.
 */
function checkBrand(data: ReturnType<typeof brandInput>): { ok: true; yaml: string } | BrandFormFailure {
  const fields = checkBrandForm(data);
  if (Object.keys(fields).length > 0) return { ok: false, problem: 'Some fields need a fix.', fields };
  const yaml = minimalBrand(data);
  const parsed = parseBrand(yaml);
  if (parsed.ok) return { ok: true, yaml };
  const mapped = brandIssuesByField(parsed.issues);
  return { ok: false, problem: mapped.other.length > 0 ? mapped.other.join('; ') : 'Some fields need a fix.', fields: mapped.fields };
}

/** The brand.yml that would be committed, checked: shown to the owner as a diff before anything is written */
export const proposeBrand = createServerFn({ method: 'POST' })
  .validator(brandInput)
  .handler(async ({ data }) => checkBrand(data));

/**
 * Commits the proposed brand.yml to the launches repo's default branch, through the App. Never over
 * an existing one: a brand.yml already there is the owner's, edited on GitHub.
 */
export const createBrand = createServerFn({ method: 'POST' })
  .validator(brandInput)
  .handler(async ({ data }) => {
    const ctx = await appContext();
    const checked = checkBrand(data);
    if (!checked.ok) return checked;
    const yaml = checked.yaml;
    try {
      if ((await ctx.github.fileAt(data.repo, 'brand.yml', 'HEAD')) !== undefined) return { ok: false as const, problem: `${data.repo} has a brand.yml already: edit it on GitHub` };
      const branch = await ctx.github.defaultBranch(data.repo);
      await ctx.github.updateFile(data.repo, branch, 'brand.yml', yaml, 'chore: add brand.yml for Shipcast');
      await ctx.announce('brand.changed', { repo: data.repo });
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, problem: message(error) };
    }
  });

/** Saves claudio's URL and token (the token goes to the keychain) */
export const saveClaudio = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = object(input, 'input');
    return { url: text(o.url, 'url', 300).trim(), token: o.token === undefined || o.token === '' ? undefined : text(o.token, 'token', 2000).trim() };
  })
  .handler(async ({ data }) => {
    const ctx = await appContext();
    try {
      await ctx.settings.write({ claudioUrl: data.url, ...(data.token && { claudioToken: data.token }) });
      await ctx.settingsSaved('claudio');
      return { ok: true as const };
    } catch (error) {
      if (error instanceof InvalidSetting) return { ok: false as const, problem: error.message };
      throw error;
    }
  });

/** Uses one provider for every task (the AI page sets them one by one), keeping the tone */
export const useProviderForAll = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!(AI_PROVIDERS as readonly unknown[]).includes(input)) throw new InvalidInput('not a provider');
    return input as AiProviderId;
  })
  .handler(async ({ data }) => {
    const ctx = await appContext();
    const current = await readAiSettings(ctx.registry);
    const tasks = Object.fromEntries(AI_TASKS.map((t) => [t, current.tasks[t].provider === data ? current.tasks[t] : { provider: data }]));
    await writeAiSettings(ctx.registry, { tasks, ...(current.tone && { tone: current.tone }) });
    return { ok: true as const };
  });

/**
 * Tests a provider without spending anything worth mentioning: its readiness where it has one
 * (claudio's proves the address, the token and the Claude sign-in), or one cheap call.
 */
export const testProvider = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!(AI_PROVIDERS as readonly unknown[]).includes(input)) throw new InvalidInput('not a provider');
    return input as AiProviderId;
  })
  .handler(async ({ data }) => {
    const ctx = await appContext();
    try {
      // The provider module's own readiness (Claudio's /api/ready says when Claude is not signed in) or one cheap call, its failure in AiError's words
      const checked = await aiProviderCheck(ctx.deps.aiRunner, data, { env: process.env, registry: ctx.registry, secrets: ctx.secrets, claudio: () => ctx.settings.claudio(), brand: () => ctx.brand() });
      return checked.ok ? { ok: true as const, detail: checked.detail } : { ok: false as const, problem: checked.problem };
    } catch (error) {
      return { ok: false as const, problem: message(error) };
    }
  });
