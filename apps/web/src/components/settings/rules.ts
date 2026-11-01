import { CHANNEL_NAMES } from '../../server/view.ts';

/** A trigger rule as the Automation page edits it (docs/launch-triggers.md); the engine checks it on save */
export interface RuleDraft {
  id: string;
  enabled: boolean;
  event: 'release' | 'public';
  repos: string;
  prereleases: boolean;
  /** Null: a repo with no launch.yml is left alone; a list: it is launched on these, each waiting for approval */
  channels: string[] | null;
}

/** A rule's event in words: "A release is published, pre-releases too" */
export function ruleTitle(rule: Pick<RuleDraft, 'event' | 'prereleases'>): string {
  if (rule.event === 'public') return 'A repo is made public';
  return rule.prereleases ? 'A release is published, pre-releases too' : 'A release is published';
}

/** What a rule does with a repo that has no launch.yml: "Leave it alone", "Launch it on Blog, Bluesky" */
export function ruleWithout(rule: Pick<RuleDraft, 'channels'>): string {
  if (rule.channels === null) return 'Leave it alone';
  if (rule.channels.length === 0) return 'Launch it on no channel';
  return `Launch it on ${rule.channels.map((c) => CHANNEL_NAMES[c] ?? c).join(', ')}`;
}

