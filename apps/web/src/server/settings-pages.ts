/*
 * Which Settings page the address is on, for the user menu's submenu and the phone's More drawer.
 * Pure so the rule is tested: `/settings` is General only when exact (its children are other pages),
 * and each child owns its own path and anything under it, never a sibling that shares a prefix.
 */

export const SETTINGS_PAGES = ['/settings', '/settings/ai', '/settings/automation', '/settings/api'] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number];

/** A trailing slash is the same page: `/settings/ai/` is AI */
function normalize(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.replace(/\/+$/, '') || '/' : path;
}

/** The Settings page the path is on, or null outside Settings (or on an unknown Settings path) */
export function currentSettingsPage(path: string): SettingsPage | null {
  const p = normalize(path);
  if (p === '/settings') return '/settings';
  for (const page of SETTINGS_PAGES) {
    if (page !== '/settings' && (p === page || p.startsWith(`${page}/`))) return page;
  }
  return null;
}

/** Whether the path is anywhere in Settings, so the submenu's trigger can say it is the current section */
export function inSettings(path: string): boolean {
  const p = normalize(path);
  return p === '/settings' || p.startsWith('/settings/');
}
