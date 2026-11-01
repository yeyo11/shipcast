import { useRouterState } from '@tanstack/react-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Attention } from '../../server/attention';
import { getAttention } from '../../server/attention.functions';
import { useLiveEnabled, useLiveInterest } from '../live/Live';

/*
 * What every screen's bars share: what needs the owner (the bell's count, Comments' badge, the
 * failing accounts behind More) and the ways to open the search palette and the bell. One read for
 * all of them, so the top bar, the bottom bar and the desktop header never disagree.
 */

/** Fresh enough that a failure shows without a click, calm enough not to hammer the engine */
const REFRESH_MS = 3 * 60_000;

export interface ShellState {
  attention: Attention | null;
  setAttention: (update: (now: Attention | null) => Attention | null) => void;
  reloadAttention: () => Promise<void>;
  /** Comments waiting for a reply: Comments' badge */
  commentsWaiting: number;
  /** Accounts whose credential failed: the mark on Channels */
  brokenAccounts: number;
  notificationsOpen: boolean;
  setNotificationsOpen: (open: boolean) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  moreOpen: boolean;
  setMoreOpen: (open: boolean) => void;
}

const ShellContext = createContext<ShellState | null>(null);

export function useShell(): ShellState {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error('useShell outside the app shell');
  return shell;
}

export function ShellProvider({ children }: { children: ReactNode }) {
  const [attention, setAttentionState] = useState<Attention | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const path = useRouterState({ select: (s) => s.location.pathname });

  const reloadAttention = useCallback(async () => {
    try {
      setAttentionState(await getAttention());
    } catch {
      // A failed read keeps what was shown: the bars must never turn into an error of their own
    }
  }, []);

  useEffect(() => {
    void reloadAttention();
    setMoreOpen(false);
  }, [reloadAttention, path]);
  // Live (realtime-ui): read again when something the lines come from changes, never on a timer
  const live = useLiveEnabled();
  useLiveInterest(live ? ['attention', 'launch', 'post', 'comment', 'account'] : null, { reload: () => void reloadAttention(), debounceMs: 1000 });
  useEffect(() => {
    if (live) return;
    const timer = setInterval(() => void reloadAttention(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, reloadAttention]);

  const value = useMemo<ShellState>(() => {
    const items = attention?.items ?? [];
    return {
      attention,
      setAttention: (update) => setAttentionState(update),
      reloadAttention,
      commentsWaiting: items.find((i) => i.kind === 'reply')?.count ?? 0,
      brokenAccounts: items.filter((i) => i.kind === 'reconnect').length,
      notificationsOpen,
      setNotificationsOpen,
      paletteOpen,
      setPaletteOpen,
      moreOpen,
      setMoreOpen,
    };
  }, [attention, reloadAttention, notificationsOpen, paletteOpen, moreOpen]);

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

/** A count in a badge: nine and more read "9+" */
export const badgeText = (n: number) => (n > 9 ? '9+' : String(n));
