import { channelName } from '@shipcast/schema/channels';

/*
 * The AI settings' words, shared by Settings › AI and its Prompts page.
 */

/**
 * Settings › AI's tabs, as Stats has them: the tab is in the address (`?tab=tasks`), the first one
 * left out. A link to a section's old anchor (`#st-tone`, from when the page was one long column)
 * opens its tab.
 */
export const AI_TABS = ['providers', 'tasks', 'tone', 'prompts'] as const;
export type AiTab = (typeof AI_TABS)[number];
export const AI_TAB_NAMES: Record<AiTab, string> = { providers: 'Providers', tasks: 'Tasks', tone: 'Tone', prompts: 'Prompts' };

const isAiTab = (value: unknown): value is AiTab => typeof value === 'string' && (AI_TABS as readonly string[]).includes(value);

/** The tab named in the address, as the route keeps it: undefined for the first one or for none */
export function readAiTab(raw: Record<string, unknown>): Exclude<AiTab, 'providers'> | undefined {
  return isAiTab(raw.tab) && raw.tab !== 'providers' ? raw.tab : undefined;
}

/** The tab on screen: the address's, else an old section anchor's (`#st-tasks-d` too), else Providers */
export function aiTabOf(tab: AiTab | undefined, hash: string): AiTab {
  if (tab) return tab;
  const anchored = /^#?st-([a-z]+?)(?:-d)?$/.exec(hash)?.[1];
  return isAiTab(anchored) ? anchored : 'providers';
}

/** Each task's name and what it covers, in the board's short form */
export const TASK_TEXT: Record<string, { label: string; text: string }> = {
  pack: { label: 'Launch content pack', text: 'The article and every post of a release' },
  article: { label: 'Article distribution', text: 'The pieces of an article you wrote' },
  assistant: { label: 'Writing assistant', text: 'Assist and the chat' },
  replies: { label: 'Comment replies', text: 'A draft for each reply' },
  profile: { label: 'Profile review', text: 'An account’s profile, field by field' },
};

/** The limits each task carries: the assistant's check against the code has one of its own */
export const BUDGETS_OF: Record<string, Array<{ task: string; label: string }>> = {
  pack: [{ task: 'pack', label: 'Limit per pack' }],
  article: [{ task: 'article', label: 'Limit per article' }],
  assistant: [
    { task: 'assistant', label: 'Limit per suggestion' },
    { task: 'assistant-check', label: 'Limit per check against the code' },
  ],
  replies: [{ task: 'replies', label: 'Limit per reply' }],
  profile: [{ task: 'profile', label: 'Limit per review' }],
};

/** "$4.00" */
export const usd = (n: number) => `$${n.toFixed(2)}`;

/** An editable prompt's name, as the board says it ("A launch", "A reply to a comment") */
export function promptLabel(id: string): string {
  if (id === 'article') return 'An article’s translation';
  if (id === 'reply') return 'A reply to a comment';
  if (id === 'profile') return 'A profile review';
  const [group, name = ''] = id.split('.');
  if (group === 'pack') return name === 'launch' ? 'A first launch' : `A ${name} version`;
  return `A post on ${channelName(name)}`;
}

/** Whether a prompt's text in use is not the one the code ships */
export function promptEdited(prompt: { default: string; versions: ReadonlyArray<{ text: string }> }): boolean {
  const current = prompt.versions.at(-1)?.text;
  return current !== undefined && current !== prompt.default;
}

/** How many locked rules are appended after the prompts (the pack's schema counts as one) */
export function lockedRuleCount(locked: Record<string, string | readonly string[]>): number {
  return Object.values(locked).reduce((n, v) => n + (Array.isArray(v) ? v.length : 1), 0);
}
