import { z } from 'zod';
import { Channel } from './channels.ts';

/*
 * The owner's trigger rules (docs/launch-triggers.md): which GitHub events create a launch, kept as
 * a setting (`triggers`) rather than in each repo's launch.yml, which becomes optional input. Read
 * only with the `launch-triggers` flag; without it launch.yml's `triggers` decide, as before.
 */

/** What happened on GitHub: a release was published, or a repo went from private to public */
export const TriggerEvent = z.enum(['release', 'public']);
export type TriggerEvent = z.infer<typeof TriggerEvent>;

/** `*` (every repo), `owner/*` (every repo of an account) or `owner/name` */
const RepoPattern = z
  .string()
  .trim()
  .regex(/^(\*|[A-Za-z0-9-]+\/(\*|[A-Za-z0-9._-]+))$/, 'a repo pattern: *, owner/* or owner/name');

export const TriggerRule = z.strictObject({
  /** Stable, so an edit names the rule it changes */
  id: z.string().regex(/^[a-z0-9-]{1,40}$/, 'a rule id is lowercase letters, digits and hyphens'),
  enabled: z.boolean().default(true),
  event: TriggerEvent,
  repos: RepoPattern.default('*'),
  /** Whether a pre-release triggers too; GitHub's pre-releases never did before the rules */
  prereleases: z.boolean().default(false),
  /**
   * The channels of a launch whose repo has no launch.yml, each waiting for approval; null leaves
   * such a repo alone, as before the rules. A repo with a launch.yml keeps its own channels
   */
  channels: z.array(Channel).nullable().default(null),
});
export type TriggerRule = z.infer<typeof TriggerRule>;

export const MAX_TRIGGER_RULES = 20;

export const TriggerRules = z
  .array(TriggerRule)
  .max(MAX_TRIGGER_RULES, `at most ${MAX_TRIGGER_RULES} rules`)
  .superRefine((rules, ctx) => {
    const seen = new Set<string>();
    for (const [i, rule] of rules.entries()) {
      if (seen.has(rule.id)) ctx.addIssue({ code: 'custom', path: [i, 'id'], message: `two rules are called ${rule.id}` });
      seen.add(rule.id);
    }
  });

/**
 * The rules until the owner saves their own: what launch.yml alone decided before them, so turning
 * the flag on changes nothing (a release, or a repo made public, of any repo whose launch.yml asks for it)
 */
export const DEFAULT_TRIGGER_RULES: readonly TriggerRule[] = [
  { id: 'releases', enabled: true, event: 'release', repos: '*', prereleases: false, channels: null },
  { id: 'made-public', enabled: true, event: 'public', repos: '*', prereleases: false, channels: null },
];

/** Whether `owner/name` is one the pattern names, case-insensitively as GitHub compares them */
export function repoMatches(pattern: string, repo: string): boolean {
  const p = pattern.trim().toLowerCase();
  const r = repo.toLowerCase();
  if (p === '*') return true;
  if (p.endsWith('/*')) return r.startsWith(p.slice(0, -1));
  return p === r;
}

/** The first enabled rule an event matches, in the owner's order; none means it creates nothing */
export function matchingRule(
  rules: readonly TriggerRule[],
  event: { type: TriggerEvent; repo: string; prerelease?: boolean },
): TriggerRule | undefined {
  return rules.find((rule) => rule.enabled && rule.event === event.type && repoMatches(rule.repos, event.repo) && (!event.prerelease || rule.prereleases));
}
