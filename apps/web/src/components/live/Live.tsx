import { useRouter } from '@tanstack/react-router';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { LiveClient, type Interest, type LiveEvent, type LiveStatus, type Topic } from './client';

/*
 * The React side of the live client (client.ts): one LiveClient per tab, made when the shell mounts
 * with `realtime-ui` on. Off, there is no client: every hook says `enabled: false` and each page
 * keeps the polling it always had, so turning the flag off is exactly the app before phase 9.
 */

interface LiveValue {
  client: LiveClient | undefined;
  enabled: boolean;
}

const LiveContext = createContext<LiveValue>({ client: undefined, enabled: false });

export function LiveProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [client, setClient] = useState<LiveClient | undefined>(undefined);
  // In the browser only, once: the server render has no EventSource and no stream to keep
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    const made = new LiveClient({ connect: (url) => new EventSource(url) });
    setClient(made);
    return () => made.stop();
  }, [enabled]);
  return <LiveContext.Provider value={{ client, enabled }}>{children}</LiveContext.Provider>;
}

/** Whether the pages follow the stream (the flag), whatever the stream's state right now */
export function useLiveEnabled(): boolean {
  return useContext(LiveContext).enabled;
}

export function useLiveStatus(): LiveStatus | undefined {
  const { client } = useContext(LiveContext);
  const [status, setStatus] = useState<LiveStatus | undefined>(client?.status);
  useEffect(() => {
    if (!client) return;
    setStatus(client.status);
    return client.onStatus(setStatus);
  }, [client]);
  return status;
}

/**
 * Registers an interest while the component is mounted and `topics` holds. The callbacks are read
 * through a ref, so a new closure on every render does not re-register (nor reopen the stream).
 */
export function useLiveInterest(topics: readonly Topic[] | null, handlers: Pick<Interest, 'reload' | 'accepts' | 'onEvent' | 'debounceMs'>): void {
  const { client } = useContext(LiveContext);
  const latest = useRef(handlers);
  latest.current = handlers;
  const key = topics?.join(',') ?? '';
  useEffect(() => {
    if (!client || !topics || topics.length === 0) return;
    return client.register({
      topics,
      reload: () => latest.current.reload(),
      accepts: (e: LiveEvent) => latest.current.accepts?.(e) ?? true,
      onEvent: (e: LiveEvent) => latest.current.onEvent?.(e),
      ...(handlers.debounceMs !== undefined && { debounceMs: handlers.debounceMs }),
    });
    // `key` stands for `topics`: a new array with the same topics is the same interest
  }, [client, key]);
}

/**
 * A route's loader, re-run for the events of `topics` and for nothing else: only this route's match
 * is invalidated, never its parents' (the shell's loader stays as it is). A reload asked while the
 * router is still loading waits for it, so reads never pile up.
 */
export function useLiveRoute(routeId: string, topics: readonly Topic[] | null): void {
  const router = useRouter();
  const reload = () => {
    const run = () => void router.invalidate({ filter: (match) => match.routeId === routeId });
    if (router.state.status !== 'pending') return run();
    const off = router.subscribe('onResolved', () => {
      off();
      run();
    });
  };
  useLiveInterest(topics, { reload });
}

/** Said quietly, once the stream has been down a while: the page is now read again once a minute */
export function LiveStatusNote() {
  const status = useLiveStatus();
  if (status !== 'down') return null;
  return (
    <p className="live-note muted" role="status">
      Live updates are paused; this page refreshes every minute until they are back.
    </p>
  );
}
