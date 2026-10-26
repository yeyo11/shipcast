/*
 * The onboarding's state machine: five steps, each pending, done or skipped, kept in the registry's
 * settings under `onboarding:state`. Pure, so the tests drive it without a database. What is already
 * configured is detected and marked done, so an install set up before the onboarding existed is never
 * walked through it again, blocked or reset. See docs/decisions/onboarding.md
 */

export const ONBOARDING_KEY = 'onboarding:state';

export const STEPS = ['brand', 'ai', 'channels', 'measure', 'automation'] as const;
export type Step = (typeof STEPS)[number];
export type StepState = 'pending' | 'done' | 'skipped';

export const STEP_TITLES: Record<Step, string> = {
  brand: 'Brand and blog',
  ai: 'AI provider',
  channels: 'Channels',
  measure: 'Measurement',
  automation: 'Automation',
};

export interface OnboardingState {
  steps: Record<Step, StepState>;
  /**
   * Whether the onboarding opens by itself on the next visit: only for a new install, until it is
   * finished or set aside. Everyone else opens it from Settings ("Finish setting up").
   */
  autoOpen: boolean;
  createdAt: string;
  finishedAt?: string;
  /** The tour: offered when the onboarding ends, then taken or declined */
  tour?: 'offered' | 'taken' | 'declined';
}

/** What is configured already, per step, as the install reads now */
export type Detected = Record<Step, boolean>;

const isStep = (value: unknown): value is Step => typeof value === 'string' && (STEPS as readonly string[]).includes(value);
const isState = (value: unknown): value is StepState => value === 'pending' || value === 'done' || value === 'skipped';

/**
 * The state on the first sign-in: what is configured is done; the rest pending. It opens by itself
 * only when the install is new (no launch yet and no brand), never over an install already working.
 */
export function initialState(detected: Detected, context: { hasLaunches: boolean }, now = new Date()): OnboardingState {
  const steps = Object.fromEntries(STEPS.map((s) => [s, detected[s] ? 'done' : 'pending'])) as Record<Step, StepState>;
  const fresh = !context.hasLaunches && !detected.brand;
  return { steps, autoOpen: fresh && STEPS.some((s) => steps[s] === 'pending'), createdAt: now.toISOString() };
}

/** A stored state read back defensively: a row from an older or broken write never breaks the app */
export function readState(stored: unknown): OnboardingState | undefined {
  if (!stored || typeof stored !== 'object') return undefined;
  const value = stored as Partial<OnboardingState> & { steps?: Record<string, unknown> };
  const steps = Object.fromEntries(STEPS.map((s) => [s, isState(value.steps?.[s]) ? value.steps![s] : 'pending'])) as Record<Step, StepState>;
  return {
    steps,
    autoOpen: value.autoOpen === true,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
    ...(typeof value.finishedAt === 'string' && { finishedAt: value.finishedAt }),
    ...((value.tour === 'offered' || value.tour === 'taken' || value.tour === 'declined') && { tour: value.tour }),
  };
}

/**
 * Brings a state up to what is configured now: a step found configured is done, whatever it was. A
 * done step never goes back to pending (a channel disconnected later is the Channels page's
 * business, not a reason to reopen the onboarding).
 */
export function reconcile(state: OnboardingState, detected: Detected): OnboardingState {
  const steps = { ...state.steps };
  for (const s of STEPS) if (detected[s]) steps[s] = 'done';
  return { ...state, steps };
}

export function complete(state: OnboardingState, step: Step): OnboardingState {
  return { ...state, steps: { ...state.steps, [step]: 'done' } };
}

/** "Skip for now": the step is left for later, resumable from Settings */
export function skip(state: OnboardingState, step: Step): OnboardingState {
  if (state.steps[step] === 'done') return state;
  return { ...state, steps: { ...state.steps, [step]: 'skipped' } };
}

/** The onboarding reaches its end: it no longer opens by itself, and the tour is offered once */
export function finish(state: OnboardingState, now = new Date()): OnboardingState {
  return { ...state, autoOpen: false, finishedAt: state.finishedAt ?? now.toISOString(), tour: state.tour ?? 'offered' };
}

/** "Set it up later": out of the way until the owner opens it from Settings */
export function setAside(state: OnboardingState): OnboardingState {
  return { ...state, autoOpen: false };
}

/** The tour offer answered, either way: the onboarding is over, so it no longer opens by itself */
export function answerTour(state: OnboardingState, answer: 'taken' | 'declined'): OnboardingState {
  return { ...state, autoOpen: false, tour: answer };
}

/** Steps still to do, skipped ones included, in order */
export function remaining(state: OnboardingState): Step[] {
  return STEPS.filter((s) => state.steps[s] !== 'done');
}

/** Where a resumed onboarding starts: the first pending step, else the first skipped one */
export function resumeAt(state: OnboardingState): Step | undefined {
  return STEPS.find((s) => state.steps[s] === 'pending') ?? STEPS.find((s) => state.steps[s] === 'skipped');
}

/** The step after one, or undefined at the end */
export function after(step: Step): Step | undefined {
  return STEPS[STEPS.indexOf(step) + 1];
}

export function parseStep(value: unknown): Step {
  if (!isStep(value)) throw new Error(`the onboarding has no step "${String(value)}"`);
  return value;
}

/** The smallest brand.yml that validates, from four answers */
export function minimalBrand(input: { id: string; displayName: string; site: string; github: string; languages: string[] }): string {
  const quote = (v: string) => JSON.stringify(v);
  return [
    '# Who the launches speak for: see Shipcast’s docs/brands.md for every field',
    `id: ${input.id}`,
    `displayName: ${quote(input.displayName)}`,
    `site: ${quote(input.site.replace(/\/+$/, ''))}`,
    `github: ${quote(input.github)}`,
    'languages:',
    `  blog: [${input.languages.join(', ')}]`,
    '',
  ].join('\n');
}

/** The fields of the minimal brand.yml the onboarding writes */
export type BrandField = 'displayName' | 'site' | 'github' | 'languages';
export type BrandFieldProblems = Partial<Record<BrandField, string>>;

const BRAND_FIELD_PROBLEM: Record<BrandField, string> = {
  displayName: 'Write your name as it signs the launches.',
  site: 'Write the blog’s full address, starting with https:// (for example https://example.com).',
  github: 'Write your GitHub login only, without the URL (for example octocat).',
  languages: 'Choose at least one language.',
};

/**
 * The brand form checked before anything goes to the server, with the same rules the brand.yml
 * schema applies, said per field in plain words: the schema's own messages name YAML lines the
 * person never saw.
 */
export function checkBrandForm(form: { displayName: string; site: string; github: string; languages: readonly string[] }): BrandFieldProblems {
  const problems: BrandFieldProblems = {};
  if (!form.displayName.trim()) problems.displayName = BRAND_FIELD_PROBLEM.displayName;
  if (!isFullHttpsUrl(form.site.trim())) problems.site = BRAND_FIELD_PROBLEM.site;
  if (!/^[A-Za-z0-9-]+$/.test(form.github.trim())) problems.github = BRAND_FIELD_PROBLEM.github;
  if (form.languages.length === 0) problems.languages = BRAND_FIELD_PROBLEM.languages;
  return problems;
}

function isFullHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    // A host with a dot: "https://blog" parses, but no blog lives there
    return url.protocol === 'https:' && url.hostname.includes('.') && !url.hostname.startsWith('.') && !url.hostname.endsWith('.');
  } catch {
    return false;
  }
}

/**
 * The brand.yml schema's issues, mapped to the form field each belongs to (the brand id is derived
 * from the GitHub login, so its issue is the login's). What belongs to no field is kept apart.
 */
export function brandIssuesByField(issues: ReadonlyArray<{ path: string; message: string }>): { fields: BrandFieldProblems; other: string[] } {
  const fields: BrandFieldProblems = {};
  const other: string[] = [];
  for (const issue of issues) {
    const top = issue.path.split('.')[0] ?? '';
    const field: BrandField | undefined = top === 'id' ? 'github' : top === 'displayName' || top === 'site' || top === 'github' || top === 'languages' ? top : undefined;
    if (field) fields[field] = BRAND_FIELD_PROBLEM[field];
    else other.push(issue.message);
  }
  return { fields, other };
}
