/*
 * The Channels screens' words, from the page's data: what an account's card leads with, how fresh
 * it is, what its state is called and what a broken one stops. Pure, so the tests read them as the
 * owner does.
 */

/** As the app's `number` (components/ui), kept here so this module stays plain TypeScript the tests import */
const number = (n: number) => (Number.isInteger(n) ? n.toLocaleString('en') : n.toFixed(2));

type Snapshot = { followers?: number | null; following?: number | null; posts?: number | null; extra?: unknown } | null | undefined;

export interface KeyMetric {
  value: number | null;
  label: string;
  others: string | null;
}

/**
 * The number an account's card leads with: what its network counts that matters (followers on a
 * social network, a channel's members, Reddit's karma, the newsletter's subscribers, the blog's
 * visits, search clicks), under its own name, with the network's other counts beside it.
 * Null where the network gives nothing to read (Discord without the invite, LinkedIn).
 */
export function keyMetric(network: string, snapshot: Snapshot): KeyMetric | null {
  const extra = (snapshot?.extra ?? {}) as Record<string, number | undefined>;
  const n = (v: number | null | undefined, word: string) => (v === null || v === undefined ? null : `${number(v)} ${word}`);
  const line = (...parts: Array<string | null>) => parts.filter(Boolean).join(' · ') || null;
  switch (network) {
    case 'linkedin':
      return null;
    // Counted only when the account has the server's invite
    case 'discord':
      return snapshot?.followers == null ? null : { value: snapshot.followers, label: 'Members', others: line(n(extra.online, 'online')) };
    case 'github':
      return { value: snapshot?.followers ?? null, label: 'Followers', others: line(n(snapshot?.following, 'following'), n(extra.repos, 'public repos')) };
    case 'telegram':
      return { value: snapshot?.followers ?? null, label: 'Subscribers', others: null };
    case 'reddit':
      return { value: extra.karma ?? null, label: 'Karma', others: line(n(snapshot?.followers, 'followers')) };
    case 'brevo':
      return { value: snapshot?.followers ?? null, label: 'Subscribers', others: null };
    case 'cloudflare':
    case 'umami':
      return { value: extra.visits7d ?? null, label: 'Visits, last 7 days', others: null };
    case 'searchConsole':
    case 'bingWebmaster':
      return { value: extra.clicks28d ?? null, label: 'Clicks, last 28 days', others: line(n(extra.impressions28d, 'impressions')) };
    // The account's own insights of the last day, from the daily snapshot
    case 'instagram':
      return { value: snapshot?.followers ?? null, label: 'Followers', others: line(n(snapshot?.following, 'following'), n(snapshot?.posts, 'posts'), n(extra.views1d, 'views, last day')) };
    case 'threads':
      return { value: snapshot?.followers ?? null, label: 'Followers', others: line(n(extra.profileViews1d, 'profile views, last day')) };
    // A Page's likes are its own count, beside its followers
    case 'facebook':
      return { value: snapshot?.followers ?? null, label: 'Followers', others: line(n(extra.likes, 'likes')) };
    case 'devto':
    case 'hashnode':
      return { value: snapshot?.followers ?? null, label: 'Followers', others: line(n(snapshot?.posts, 'articles')) };
    default:
      return { value: snapshot?.followers ?? null, label: 'Followers', others: line(n(snapshot?.following, 'following'), n(snapshot?.posts, 'posts')) };
  }
}

/** How long ago, in the board's short words: "just now", "12 min ago", "2 h ago", "3 d ago" */
export function ago(iso: string, now: string): string {
  const minutes = Math.floor((Date.parse(now) - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** A day as "26 Oct", in UTC as the registry keeps it */
export function shortDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export type AccountState = 'ok' | 'failed' | 'unchecked';

export function stateOf(status: string | null | undefined): AccountState {
  return status === 'ok' ? 'ok' : status === 'failed' ? 'failed' : 'unchecked';
}

export const STATE_WORD: Record<AccountState, string> = { ok: 'Connected', failed: 'Not working', unchecked: 'Not checked' };

/** The pill's shape for a state: filled when it works, the red diamond when it does not, dotted while unchecked */
export const STATE_PILL: Record<AccountState, string> = { ok: 'k-p-pub', failed: 'k-p-fail', unchecked: 'k-p-draft' };

/** What a broken account stops, after its problem: a channel publishes nothing, a source reads nothing */
export function brokenLine(network: { name: string; channel?: string | undefined; ai?: boolean | undefined }, problem: string | null | undefined): string {
  const said = (problem ?? 'Its last check failed').trim().replace(/[.:;,\s]+$/, '');
  const stops = network.ai
    ? `${network.name} writes nothing until you reconnect it`
    : network.channel
      ? `Nothing goes out to ${network.name} until you reconnect it`
      : `${network.name}’s numbers are not read until you reconnect it`;
  return `${said}. ${stops}.`;
}

/** The networks a "connect another" card names: the first few not connected yet, then an ellipsis */
export function namesToConnect(names: readonly string[], max = 5): string {
  if (names.length === 0) return 'Another account on a network you use';
  return names.length > max ? `${names.slice(0, max).join(', ')}…` : names.join(', ');
}

/** What connecting the account again needs, for the disconnect's warning: the form's secret, or the network's sign-in */
export function credentialWord(network: { auth: 'oauth' | 'form'; name: string; fields: ReadonlyArray<{ label: string; secret: boolean; optional?: boolean | undefined }> }): string {
  if (network.auth === 'oauth') return `authorising Shipcast on ${network.name} again`;
  const secret = network.fields.find((f) => f.secret && !f.optional);
  return secret ? `a new ${secret.label.toLowerCase()}` : 'its details again';
}

/**
 * What stops an OAuth network's sign-in, in the words Settings labels the field with. A network's app
 * is not always its own (Facebook signs in with the Meta app), so its name cannot be assumed here.
 */
export function needsAppLine(network: string, missing: string | undefined): string {
  const what = missing ? `${missing.charAt(0).toLowerCase()}${missing.slice(1)}` : 'its app’s id and secret';
  return `Connecting ${network} needs ${what}: set that in Settings.`;
}

/** When something was read, as a sentence ends it: "today", "yesterday", "on 26 Oct" (UTC days) */
export function dayWord(iso: string, now: string): string {
  const day = (s: string) => Math.floor(Date.parse(s) / 86_400_000);
  const days = day(now) - day(iso);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `on ${shortDay(iso)}`;
}

/** How one account's sync ended: Sync now's answer, or the error its call threw */
export interface SyncOutcome {
  name: string;
  state: 'completed' | 'failed' | 'queued';
  problem?: string | undefined;
}

/**
 * Sync all's toast: how many of the tab's accounts synced, then what did not, by name. A failure
 * makes it a failed toast; a sync still running when the page stopped waiting is not one.
 */
export function syncAllSummary(outcomes: readonly SyncOutcome[], skipped: readonly string[] = []): { tone: 'ok' | 'bad'; title: string; text?: string } {
  const synced = outcomes.filter((o) => o.state === 'completed').length;
  const failed = outcomes.filter((o) => o.state === 'failed');
  const running = outcomes.filter((o) => o.state === 'queued');
  const title = synced === outcomes.length ? (synced === 1 ? `Synced ${outcomes[0]?.name ?? 'the account'}` : `Synced all ${synced}`) : `Synced ${synced} of ${outcomes.length}`;
  const lines = [
    ...failed.map((o) => `${o.name} failed: ${o.problem ?? 'it could not be synced'}`),
    running.length > 0 && `${running.map((o) => o.name).join(', ')} still ${running.length === 1 ? 'syncs' : 'sync'}: reload the page in a minute`,
    skipped.length > 0 && `${skipped.join(', ')} ${skipped.length === 1 ? 'needs' : 'need'} reconnecting first`,
  ].filter((l): l is string => Boolean(l));
  return { tone: failed.length > 0 ? 'bad' : 'ok', title, ...(lines.length > 0 && { text: lines.join(' · ') }) };
}
