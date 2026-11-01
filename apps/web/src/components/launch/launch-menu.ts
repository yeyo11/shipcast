/*
 * What a launch's ⋯ offers (boards LaunchMenu and DesktopLaunchMenu), worked out apart from the
 * component so it can be tested: the menu never opens empty, and with nothing to offer there is no ⋯.
 */

export type LaunchMenuEntry = 'relaunch' | 'edit-text' | 'preview' | 'article' | 'publish-pending' | 'log' | 'copy-error' | 'edit-out' | 'unpublish' | 'delete';

export interface LaunchMenuState {
  /** canRelaunch (server/launch-list.ts): a release that failed before anything went out */
  relaunch: boolean;
  /** Waiting for the owner's approval */
  waiting: boolean;
  /** A launch Shipcast holds: its article has a preview */
  held: boolean;
  /** Its article is out and has an address */
  article: boolean;
  /** Drafted and approved, with pieces that did not all go out */
  pending: boolean;
  running: boolean;
  failed: boolean;
  /** The failure's words, to copy */
  problem: boolean;
  /** How many pieces that went out a network lets edit, and delete */
  editable: number;
  removable: number;
  /** Not deleted already: a launch can always be deleted (the launch-delete flag is retired) */
  deletable: boolean;
}

export function launchMenuEntries(s: LaunchMenuState): LaunchMenuEntry[] {
  const entries: LaunchMenuEntry[] = [];
  if (s.relaunch) entries.push('relaunch');
  if (s.waiting) entries.push('edit-text');
  if (s.waiting && s.held) entries.push('preview');
  if (s.article) entries.push('article');
  if (s.pending && !s.running) entries.push('publish-pending');
  if (s.failed) entries.push('log');
  if (s.failed && s.problem) entries.push('copy-error');
  if (s.editable > 0) entries.push('edit-out');
  if (s.removable > 0) entries.push('unpublish');
  if (s.deletable) entries.push('delete');
  return entries;
}

/**
 * The entries a desktop's menu shows: there "Launch it again" is the page's yellow button (board
 * DesktopLaunchMenu), so the menu leaves it out
 */
export const desktopMenuEntries = (entries: readonly LaunchMenuEntry[]): LaunchMenuEntry[] => entries.filter((e) => e !== 'relaunch');
