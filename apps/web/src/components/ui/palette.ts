import { channelName } from '@shipcast/schema/channels';
import type { AttentionItem } from '../../server/attention.ts';
import { agoLabel, launchTitle, shortDate } from '../../server/launch-list.ts';
import { isAiNetwork } from '../../server/network-groups.ts';
import type { Tone } from '../../server/view.ts';
import type { IconName } from '../kit/Icon.tsx';

/*
 * The search palette's lines as plain data (boards DesktopSearch*, SearchPalette*): what it lists on
 * an empty field, what typing finds, the "Connect an account" step and the lines tried when nothing
 * matches. Pure, so the grouping and the matching are tested without a browser; CommandPalette.tsx
 * only draws the groups and runs what a line names.
 */

/** At most this many lines per group while typing: the palette is a glance, and typing narrows it */
export const PER_GROUP = 4;

/** How many launches "Recent" lists on an empty field */
export const RECENT = 3;

export interface PalettePill {
  tone: Tone | 'line';
  label: string;
}

export type PaletteIcon =
  | { kind: 'icon'; name: IconName; bad?: boolean }
  | { kind: 'network'; network: string; bad?: boolean }
  /** A launch that failed: the red diamond */
  | { kind: 'failed' };

/** What choosing a line does: go somewhere, open a step inside the palette, or run a command */
export type PaletteRun = { kind: 'href'; href: string } | { kind: 'step'; step: 'connect' } | { kind: 'command'; command: 'round' | 'tour' | 'sign-out' };

export interface PaletteEntry {
  id: string;
  title: string;
  /** A release's version, after the title in mono */
  version?: string;
  /** The muted words before the pill (desktop only) */
  meta?: string;
  pill?: PalettePill;
  icon: PaletteIcon;
  /** Other words it is found by ("settings", "token") */
  keywords?: string;
  /** Its global shortcut, as kbd hints (desktop only) */
  keys?: readonly string[];
  run: PaletteRun;
  /** The part of the title the typed words matched, set in bold */
  hit?: readonly [number, number];
}

/** A type, not an interface: Base UI's groups take any object with `items` */
export type PaletteGroup = {
  id: string;
  label: string;
  /** How many there are in all, when the group shows only some ("Needs you · 4") */
  count?: number;
  items: PaletteEntry[];
};

/** A launch as listLaunches returns it, the part the palette reads */
export interface PaletteLaunch {
  id: number;
  repo: string;
  ref: string;
  title: string | null;
  status: string;
  state: { label: string; tone: Tone };
  createdAt: string;
  ready?: { count: number } | null;
}

/** A network as getChannels returns it, the part the palette reads */
export interface PaletteNetwork {
  id: string;
  name: string;
  /** An AI provider: configured in Settings → AI, not connected as a channel */
  ai?: boolean;
  accounts: ReadonlyArray<{ id: number; label: string; identity?: string | null; status: string | null; problem: string | null }>;
}

/** Where the Connect step sends the AI providers: Settings → AI's Providers tab (since 2026-11-02 they are not on Channels) */
export const AI_PROVIDERS_HREF = '/settings/ai?tab=providers';

export const GO_TO: readonly PaletteEntry[] = [
  { id: 'go-launches', title: 'Launches', keywords: 'home releases', icon: { kind: 'icon', name: 'launches' }, run: { kind: 'href', href: '/' } },
  { id: 'go-comments', title: 'Comments', keywords: 'replies answers mentions', icon: { kind: 'icon', name: 'comments' }, run: { kind: 'href', href: '/comments' } },
  { id: 'go-stats', title: 'Stats', keywords: 'numbers metrics charts', icon: { kind: 'icon', name: 'stats' }, run: { kind: 'href', href: '/stats' } },
  { id: 'go-channels', title: 'Channels', keywords: 'accounts networks', icon: { kind: 'icon', name: 'channels' }, run: { kind: 'href', href: '/channels' } },
  { id: 'go-write', title: 'Write', keywords: 'article blog', icon: { kind: 'icon', name: 'write' }, run: { kind: 'href', href: '/write' } },
  { id: 'go-settings', title: 'Settings', keywords: 'github app configuration brand general', icon: { kind: 'icon', name: 'more' }, run: { kind: 'href', href: '/settings' } },
  { id: 'go-ai', title: 'AI settings', keywords: 'provider model prompts tone claude', icon: { kind: 'icon', name: 'assist' }, run: { kind: 'href', href: '/settings/ai' } },
  { id: 'go-automation', title: 'Automation', keywords: 'rounds webhooks polling jobs', icon: { kind: 'icon', name: 'history' }, run: { kind: 'href', href: '/settings/automation' } },
  { id: 'go-notifications', title: 'Notifications', keywords: 'push alerts phone devices', icon: { kind: 'icon', name: 'bell' }, run: { kind: 'href', href: '/settings/notifications' } },
  { id: 'go-api', title: 'API', keywords: 'tokens rest mcp', icon: { kind: 'icon', name: 'key' }, run: { kind: 'href', href: '/settings/api' } },
];

/** The main actions; the first three are the empty field's "Actions" */
export const ACTIONS: readonly PaletteEntry[] = [
  { id: 'launch', title: 'Launch a repo', keywords: 'release draft new', keys: ['N', 'L'], icon: { kind: 'icon', name: 'plus' }, run: { kind: 'href', href: '/launch' } },
  { id: 'write', title: 'Write an article', keywords: 'post blog new', keys: ['N', 'W'], icon: { kind: 'icon', name: 'write' }, run: { kind: 'href', href: '/write' } },
  { id: 'connect', title: 'Connect an account', keywords: 'channel network add reconnect', icon: { kind: 'icon', name: 'channels' }, run: { kind: 'step', step: 'connect' } },
  { id: 'round', title: 'Run an automation round now', keywords: 'check releases publish', icon: { kind: 'icon', name: 'retry' }, run: { kind: 'command', command: 'round' } },
  { id: 'tour', title: 'Take the tour', keywords: 'help guide walkthrough', icon: { kind: 'icon', name: 'help' }, run: { kind: 'command', command: 'tour' } },
  { id: 'setup', title: 'Finish setting up', keywords: 'onboarding setup brand provider', icon: { kind: 'icon', name: 'check' }, run: { kind: 'href', href: '/onboarding' } },
  { id: 'token', title: 'Create an API token', keywords: 'rest mcp script', icon: { kind: 'icon', name: 'key' }, run: { kind: 'href', href: '/settings/api' } },
  { id: 'sign-out', title: 'Sign out', keywords: 'log out leave', icon: { kind: 'icon', name: 'external' }, run: { kind: 'command', command: 'sign-out' } },
];

/** The global two-key shortcuts: N then L launches a repo, N then W writes an article */
export const SEQUENCES: Readonly<Record<string, string>> = { l: '/launch', w: '/write' };

/** Where a two-key sequence goes: the second key after N, or nothing */
export function sequenceTarget(previous: string | null, key: string): string | null {
  return previous?.toLowerCase() === 'n' ? (SEQUENCES[key.toLowerCase()] ?? null) : null;
}

const WORD_START = /[\s\-_/:.([]/;

/**
 * Where the typed words match a line: every word has to be in its title, version or keywords, and the
 * first word's place in the title is the hit, at the start of a word when it is there ("sl" bolds the
 * "sl" of "slowly", not of "isle"). Null when a word is missing.
 */
export function matchEntry(entry: Pick<PaletteEntry, 'title' | 'version' | 'keywords'>, query: string): { hit?: readonly [number, number]; start: boolean } | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { start: false };
  const hay = `${entry.title} ${entry.version ?? ''} ${entry.keywords ?? ''}`.toLowerCase();
  if (!words.every((w) => hay.includes(w))) return null;
  const title = entry.title.toLowerCase();
  const first = words[0]!;
  let at = -1;
  for (let i = title.indexOf(first); i >= 0; i = title.indexOf(first, i + 1)) {
    if (i === 0 || WORD_START.test(title[i - 1]!)) {
      at = i;
      break;
    }
  }
  const start = at >= 0;
  if (!start) at = title.indexOf(first);
  return at >= 0 ? { hit: [at, at + first.length], start } : { start: false };
}

/** The lines that match, those matching at a word's start in their title first, each with its hit */
export function filterEntries(entries: readonly PaletteEntry[], query: string): PaletteEntry[] {
  const found = entries.flatMap((entry) => {
    const m = matchEntry(entry, query);
    return m ? [{ entry: m.hit ? { ...entry, hit: m.hit } : entry, start: m.start }] : [];
  });
  return [...found.filter((f) => f.start), ...found.filter((f) => !f.start)].map((f) => f.entry);
}

const capitalised = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A launch's line: an article by its title with the text icon, a release by its project and version */
export function launchEntry(launch: PaletteLaunch, opts: { timezone: string; now: Date; typed: boolean }): PaletteEntry {
  const t = launchTitle(launch);
  const day = shortDate(launch.createdAt, opts.timezone, opts.now);
  const drafting = launch.status === 'generating' || launch.status === 'detected';
  const meta = drafting ? `started ${agoLabel(launch.createdAt, opts.now)}` : t.article ? (opts.typed ? day : `Article · ${day}`) : opts.typed ? `${launch.repo} · ${day}` : day;
  const failed = launch.state.tone === 'failed';
  return {
    id: `launch-${launch.id}`,
    title: capitalised(t.title),
    ...(t.version && { version: t.version }),
    keywords: launch.repo,
    meta,
    pill: { tone: launch.state.tone, label: launch.state.tone === 'waiting' ? 'Waiting' : launch.state.label },
    icon: failed ? { kind: 'failed' } : { kind: 'icon', name: t.article ? 'text' : 'launches' },
    run: { kind: 'href', href: `/launches/${launch.id}` },
  };
}

/** A broken account's pill: "Expired" when its problem says the sign-in ran out, else the Channels page's word */
export function brokenWord(problem: string | null | undefined): string {
  return problem && /expir|revok|invalid.?token|unauthori[sz]ed|\b401\b/i.test(problem) ? 'Expired' : 'Not working';
}

const isBroken = (a: { status: string | null }) => a.status === 'failed';

/**
 * The bell's lines as verbs (Review, Retry, Answer, Reconnect). The other lines of the bell (a post
 * going out soon, a search engine's canonical, a permission) are notes to read, not things to do here.
 */
export function needsEntries(items: readonly AttentionItem[], launches: readonly PaletteLaunch[], networks: readonly PaletteNetwork[], now: Date): PaletteEntry[] {
  const byId = new Map(launches.map((l) => [l.id, l]));
  const named = (item: AttentionItem): { title: string; version?: string; launch?: PaletteLaunch } => {
    const id = item.target.to === '/launches/$id' ? Number(item.target.params.id) : NaN;
    const launch = byId.get(id);
    if (!launch) return { title: item.subject ?? item.text };
    const t = launchTitle(launch);
    return { title: capitalised(t.title), ...(t.version && { version: t.version }), launch };
  };
  return items.flatMap((item): PaletteEntry[] => {
    switch (item.kind) {
      case 'approve': {
        const n = named(item);
        const ready = n.launch?.ready?.count;
        const meta = [ready ? `${ready} ${ready === 1 ? 'draft' : 'drafts'}` : null, n.launch ? agoLabel(n.launch.createdAt, now) : null].filter(Boolean).join(' · ');
        return [{ id: item.key, title: `Review ${n.title}`, ...(n.version && { version: n.version }), ...(meta && { meta }), pill: { tone: 'waiting', label: 'Waiting' }, icon: { kind: 'icon', name: 'check' }, run: { kind: 'href', href: hrefOf(item) } }];
      }
      case 'retry': {
        const n = named(item);
        // The bell's line says why after "failed": the reason, or the networks it failed on
        const why = item.text.match(/ failed(?:: (.+)| (on .+))$/);
        const meta = why?.[1] ?? (why?.[2] ? `failed ${why[2]}` : undefined);
        return [{ id: item.key, title: `Retry ${n.title}`, ...(n.version && { version: n.version }), ...(meta && { meta }), pill: { tone: 'failed', label: 'Failed' }, icon: { kind: 'failed' }, run: { kind: 'href', href: hrefOf(item) } }];
      }
      case 'reply':
        return [{ id: item.key, title: `Answer ${item.subject ?? 'the comments'}`, icon: { kind: 'icon', name: 'comments' }, run: { kind: 'href', href: hrefOf(item) } }];
      case 'reconnect': {
        const network = item.channel ?? '';
        const account = networks.flatMap((n) => n.accounts).find((a) => item.target.to === '/channels' && String(a.id) === item.target.search.focus);
        return [
          {
            id: item.key,
            title: `Reconnect ${channelName(network)}`,
            ...(item.subject && { meta: item.subject }),
            pill: { tone: 'failed', label: brokenWord(account?.problem) },
            icon: { kind: 'network', network, bad: true },
            run: { kind: 'href', href: `/channels/${network}` },
          },
        ];
      }
      default:
        return [];
    }
  });
}

function hrefOf(item: AttentionItem): string {
  const t = item.target;
  switch (t.to) {
    case '/launches/$id':
      return `/launches/${t.params.id}`;
    case '/comments':
      return `/comments?state=${t.search.state}`;
    case '/channels':
      return `/channels?focus=${encodeURIComponent(t.search.focus)}`;
    case '/settings':
      return '/settings';
  }
}

/** Every connected account as a line, found by its network and its handle */
export function accountEntries(networks: readonly PaletteNetwork[]): PaletteEntry[] {
  return networks.flatMap((n) =>
    n.accounts.map((a): PaletteEntry => {
      const broken = isBroken(a);
      return {
        id: `account-${a.id}`,
        title: n.name,
        meta: a.identity ?? a.label,
        keywords: `${a.label} ${a.identity ?? ''} ${n.id} account`,
        pill: broken ? { tone: 'failed', label: brokenWord(a.problem) } : { tone: 'line', label: 'Connected' },
        icon: { kind: 'network', network: n.id, ...(broken && { bad: true }) },
        run: { kind: 'href', href: `/channels/${n.id}` },
      };
    }),
  );
}

const group = (id: string, label: string, entries: PaletteEntry[], count?: number): PaletteGroup => ({ id, label, items: entries, ...(count !== undefined && { count }) });

export interface PaletteSources {
  needs: readonly PaletteEntry[];
  launches: readonly PaletteLaunch[];
  networks: readonly PaletteNetwork[];
  timezone: string;
  now: Date;
}

/** An empty field: what needs the owner, the newest launches and the three main actions. "Go to" waits for typing. */
export function emptyGroups(s: PaletteSources): PaletteGroup[] {
  const recent = [...s.launches]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, RECENT)
    .map((l) => launchEntry(l, { timezone: s.timezone, now: s.now, typed: false }));
  return [
    group('needs', 'Needs you', s.needs.slice(0, PER_GROUP), s.needs.length > 0 ? s.needs.length : undefined),
    group('recent', 'Recent', recent),
    group('actions', 'Actions', ACTIONS.slice(0, 3)),
  ].filter((g) => g.items.length > 0);
}

/** Typed words: launches, articles, accounts, sections, actions and needs, a few of each, only the groups that match */
export function typedGroups(query: string, s: PaletteSources): PaletteGroup[] {
  const entries = s.launches.map((l) => ({ l, entry: launchEntry(l, { timezone: s.timezone, now: s.now, typed: true }) }));
  const releases = entries.filter((e) => !e.l.ref.startsWith('article:')).map((e) => e.entry);
  const articles = entries.filter((e) => e.l.ref.startsWith('article:')).map((e) => e.entry);
  return [
    group('launches', 'Launches', filterEntries(releases, query)),
    group('articles', 'Articles', filterEntries(articles, query)),
    group('accounts', 'Accounts', filterEntries(accountEntries(s.networks), query)),
    group('go', 'Go to', filterEntries(GO_TO, query)),
    group('actions', 'Actions', filterEntries(ACTIONS, query)),
    group('needs', 'Needs you', filterEntries(s.needs, query)),
  ]
    .map((g) => ({ ...g, items: g.items.slice(0, PER_GROUP) }))
    .filter((g) => g.items.length > 0);
}

/**
 * The "Connect an account" step: the broken accounts, the networks not connected and those that are.
 * The AI providers are not among them: they are one line to Settings → AI, found by their names,
 * with the broken pill when one of their keys failed.
 */
export function connectGroups(networks: readonly PaletteNetwork[], query: string): PaletteGroup[] {
  const broken: PaletteEntry[] = [];
  const add: PaletteEntry[] = [];
  const connected: PaletteEntry[] = [];
  const ai = networks.filter(isAiNetwork);
  const aiBroken = ai.flatMap((n) => n.accounts).find(isBroken);
  const providers: PaletteEntry[] =
    ai.length === 0
      ? []
      : [
          {
            id: 'ai-providers',
            title: 'AI providers',
            meta: 'Settings › AI',
            keywords: `ai model key ${ai.map((n) => `${n.id} ${n.name}`).join(' ')} openai claudio`,
            ...(aiBroken && { pill: { tone: 'failed' as const, label: brokenWord(aiBroken.problem) } }),
            icon: { kind: 'icon', name: 'assist', ...(aiBroken && { bad: true }) },
            run: { kind: 'href', href: AI_PROVIDERS_HREF },
          },
        ];
  for (const n of networks.filter((x) => !isAiNetwork(x))) {
    for (const a of n.accounts.filter(isBroken)) {
      broken.push({ id: `reconnect-${a.id}`, title: `Reconnect ${n.name}`, meta: a.identity ?? a.label, keywords: n.id, pill: { tone: 'failed', label: brokenWord(a.problem) }, icon: { kind: 'network', network: n.id, bad: true }, run: { kind: 'href', href: `/channels/${n.id}` } });
    }
    const working = n.accounts.filter((a) => !isBroken(a));
    if (n.accounts.length === 0) add.push({ id: `add-${n.id}`, title: n.name, keywords: n.id, icon: { kind: 'network', network: n.id }, run: { kind: 'href', href: `/channels/${n.id}` } });
    else if (working.length > 0) {
      const first = working[0]!;
      connected.push({ id: `connected-${n.id}`, title: n.name, meta: first.identity ?? first.label, keywords: n.id, pill: { tone: 'line', label: 'Connected' }, icon: { kind: 'network', network: n.id }, run: { kind: 'href', href: `/channels/${n.id}` } });
    }
  }
  const narrowed = (entries: PaletteEntry[]) => (query.trim() ? filterEntries(entries, query) : entries);
  const b = narrowed(broken);
  const a = narrowed(add);
  const c = narrowed(connected);
  return [group('needs', 'Needs you', b), group('add', 'Add a network', a, a.length), group('connected', 'Already connected', c, c.length), group('ai', 'In Settings', narrowed(providers))].filter((g) => g.items.length > 0);
}

/** A repo's name as GitHub allows it, the part after the owner */
export const isRepoName = (name: string) => /^[A-Za-z0-9._-]{1,100}$/.test(name) && name !== '.' && name !== '..';

/** Nothing matches: launch a repo by that name (when it can be one), or search every launch for the words */
export function tryGroup(query: string, owner: string | null): PaletteGroup {
  const q = query.trim();
  const entries: PaletteEntry[] = [];
  if (owner && isRepoName(q)) {
    entries.push({ id: 'try-launch', title: `Launch a repo called ${q}`, meta: `${owner}/${q}`, icon: { kind: 'icon', name: 'plus' }, run: { kind: 'href', href: `/launch?repo=${encodeURIComponent(`${owner}/${q}`)}` } });
  }
  entries.push({ id: 'try-search', title: `Search all launches for “${q}”`, meta: 'on the Launches page', icon: { kind: 'icon', name: 'search' }, run: { kind: 'href', href: `/?q=${encodeURIComponent(q)}` } });
  return group('try', 'Try', entries);
}
