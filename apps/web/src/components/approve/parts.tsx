import { useCallback, useEffect, useState } from 'react';
import { ChannelGlyph } from '../launch/ChannelGlyph';
import type { getLaunch } from '../../server/launches.functions';
import type { Piece } from './model';

/*
 * What the launch-to-approve screens share: the launch's data types, a network's glyph in the text's
 * colour, an inline word diff and the owner's per-piece approvals.
 */

export type LaunchData = NonNullable<Awaited<ReturnType<typeof getLaunch>>>;
export type ReviewOk = Exclude<LaunchData['review'], null | { error: string }>;
export type DraftView = ReviewOk['drafts'][number];

/** A network's own mark, in the text's colour (the launch page's shared glyph) */
export function Glyph({ name, size = 19 }: { name: string; size?: number }) {
  return <ChannelGlyph channel={name} size={size} />;
}

/**
 * The owner's approval piece by piece. The engine approves a launch whole, so a piece ticked here is
 * kept in this browser, against the version of its text it was ticked on, until the launch is
 * approved; a piece whose drafts are the approved versions already counts as approved.
 */
export function useMarks(launchId: number, pieces: readonly Piece<DraftView>[]) {
  const key = `shipcast:approve:${launchId}`;
  const [stored, setStored] = useState<Record<string, string>>({});
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      setStored(raw ? (JSON.parse(raw) as Record<string, string>) : {});
    } catch {
      setStored({});
    }
  }, [key]);
  const write = useCallback(
    (change: (now: Record<string, string>) => Record<string, string>) => {
      setStored((now) => {
        const next = change(now);
        try {
          window.localStorage.setItem(key, JSON.stringify(next));
        } catch {
          // Private windows and blocked storage: the ticks last as long as the page
        }
        return next;
      });
    },
    [key],
  );
  const isApproved = useCallback((p: Piece<DraftView>) => stored[p.id] === p.fingerprint || (p.drafts.length > 0 && p.drafts.every((d) => d.approved === true)), [stored]);
  return {
    isApproved,
    toggle: (p: Piece<DraftView>) =>
      write((now) => {
        const next = { ...now };
        if (now[p.id] === p.fingerprint) delete next[p.id];
        else next[p.id] = p.fingerprint;
        return next;
      }),
    clear: () => write(() => ({})),
  };
}

/** The current time, read again every half minute so "3 min ago" and a countdown keep up */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
