/*
 * Settings' wording, kept pure so it is tested: how many changes wait, how long ago something
 * happened, what each runtime setting is for and how a token's use reads.
 */

/** The save bar's words: "1 change not saved", "3 changes not saved" */
export function changesText(count: number): string {
  return `${count} ${count === 1 ? 'change' : 'changes'} not saved`;
}

const MONTH = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** A past moment for reading: "just now", "12 min ago", "3 h ago", then the day ("12 Oct") */
export function ago(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return MONTH.format(at);
}

/** A day for a list: "12 Oct" */
export function shortDay(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? iso : MONTH.format(at);
}

/** An address without its scheme or trailing slash: `claudio.local:8790` */
export function hostOf(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
}

/** A network's app setting, read from its label ("The LinkedIn client id"): the network and which half */
export function oauthPart(label: string): { network: string; part: 'id' | 'secret' } | null {
  const m = /^The (.+?) (?:app|client) (id|secret)$/.exec(label);
  return m?.[1] && m[2] ? { network: m[1], part: m[2] as 'id' | 'secret' } : null;
}

/** The line under a setting's field: what it is for, and where its value comes from while it is not saved here */
export function settingHelp(setting: { name: string; label: string; source: string }): string | null {
  const from = setting.source === '.env' ? ' Read from .env until it is saved here.' : '';
  if (setting.name === 'launchesRepo') return `Where the drafts and the blog’s articles are committed.${from}`;
  const oauth = oauthPart(setting.label);
  if (oauth?.part === 'id') return `From your ${oauth.network} app. Needed to connect ${oauth.network}.${from}`;
  return from ? from.trim() : null;
}

/** A token's line under its name: "Read, Write · used 1 h ago" */
export function tokenUse(token: { scopes: readonly string[]; lastUsedAt: string | null }, now?: number): string {
  const scopes = token.scopes.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(', ');
  return `${scopes} · ${token.lastUsedAt ? `used ${ago(token.lastUsedAt, now)}` : 'never used'}`;
}

/** How Shipcast hears about GitHub, under the webhooks' link: "Receiving · last delivery 2 min ago" */
export function listeningText(a: { mode: string; intervalSeconds: number; lastDelivery: { at: string } | null }, now?: number): string {
  if (a.mode === 'webhook') return `Receiving · ${a.lastDelivery ? `last delivery ${ago(a.lastDelivery.at, now)}` : 'nothing received yet'}`;
  if (a.mode === 'poll') return `Not in use: Shipcast polls every ${everyText(a.intervalSeconds)}`;
  return 'Not in use: nothing runs on its own';
}

/** A round's interval in words: "5 minutes", "90 seconds" */
export function everyText(seconds: number): string {
  if (seconds % 60 === 0) return seconds === 60 ? 'minute' : `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}
