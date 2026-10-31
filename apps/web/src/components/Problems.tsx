import { Link, useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';
import { explain } from './errors';
import { isOffline } from './offline';
import { NotFound, Offline, ServerError } from './illustrations';
import { BottomBar, DesktopHeader, Mark, TopBar } from './kit/Bars';
import { Icon } from './kit/Icon';
import { ShellProvider, useShell } from './kit/shell';

/*
 * The pages nobody asks for (boards NotFound, ErrorState and Offline), each with its postal scene: an
 * address with nothing behind it ("Return to sender"), a page that broke on the way ("Damaged") and
 * a mailbox with its cord cut. Each says what to do next. Inside the app they keep its bars, so the
 * way to every section stays in reach; outside it (the sign-in, the set-up) they stand alone.
 */

/** Whether the app's shell is around this page: its bars come from there, or from the page itself */
function useInShell(): boolean {
  try {
    useShell();
    return true;
  } catch {
    return false;
  }
}

/** Where a problem page sits: inside the shell, outside it but in the app, or on its own */
export type ProblemPlace = 'shell' | 'app' | 'bare';

/**
 * The page's frame. In the shell, only the phone's top bar (the shell has the rest). For a section
 * whose shell failed with it (`app`), the bars are drawn here around the page, reading what they
 * need on their own. Outside the app (`bare`), the brand alone: no bar there would lead anywhere.
 */
function Frame({ place, children }: { place: ProblemPlace; children: ReactNode }) {
  const inShell = useInShell();
  if (inShell) {
    return (
      <>
        <TopBar />
        {children}
      </>
    );
  }
  if (place === 'app') {
    return (
      <ShellProvider>
        <div className="k-desktop">
          <DesktopHeader owner={null} />
        </div>
        <TopBar />
        <main id="main" className="k-main acc-problem-main" tabIndex={-1}>
          {children}
        </main>
        <BottomBar />
      </ShellProvider>
    );
  }
  return (
    <main id="main" className="acc-problem-main" tabIndex={-1}>
      <header className="k-topbar acc-problem-bare-bar">
        <a href="/" className="k-topbar-brand" aria-label="Shipcast, the launches">
          <Mark />
          <span className="k-d acc-problem-brand">Shipcast</span>
        </a>
      </header>
      {children}
    </main>
  );
}

function Problem({ art, title, lead, actions, children, alert }: { art: ReactNode; title: string; lead: ReactNode; actions: ReactNode; children?: ReactNode; alert?: boolean }) {
  return (
    <section className="k-px k-stack k-g16 acc-problem" aria-labelledby="problem-title" role={alert ? 'alert' : undefined}>
      <div className="acc-problem-art">{art}</div>
      <h1 id="problem-title" className="k-d k-d48">
        {title}
      </h1>
      <p className="k-muted acc-problem-lead">{lead}</p>
      <div className="k-stack k-g10 acc-problem-actions">{actions}</div>
      {children}
    </section>
  );
}

export function NotFoundPage({ place = 'shell' }: { place?: ProblemPlace }) {
  return (
    <Frame place={place}>
      <Problem
        art={<NotFound />}
        title="Nothing here"
        lead="Nothing lives at this address: the launch, account or page may have moved, or never existed."
        actions={
          place === 'bare' ? (
            <a className="k-btn k-pri k-full" href="/">
              Go to Launches
            </a>
          ) : (
            <Link className="k-btn k-pri k-full" to="/">
              Go to Launches
            </Link>
          )
        }
      />
    </Frame>
  );
}

/** The page again: the route's error cleared and its data read afresh */
function useRetry(reset: () => void) {
  const router = useRouter();
  return () => {
    reset();
    void router.invalidate();
  };
}

export function ErrorPage({ error, reset, place = 'shell' }: ErrorComponentProps & { place?: ProblemPlace }) {
  // Read once mounted: the server render has no connection to report on
  const [online, setOnline] = useState(true);
  useEffect(() => setOnline(navigator.onLine), []);
  if (isOffline(error, online)) return <OfflinePage reset={reset} place={place} />;
  return <BrokenPage error={error} reset={reset} place={place} />;
}

function BrokenPage({ error, reset, place }: { error: unknown; reset: () => void; place: ProblemPlace }) {
  const retry = useRetry(reset);
  const raw = error instanceof Error ? error.message : String(error);
  const e = explain(raw);
  return (
    <Frame place={place}>
      <Problem
        alert
        art={<ServerError />}
        title="That did not load"
        lead="Shipcast could not finish this page. The rest of the app still works; try again in a moment."
        actions={
          <>
            <button type="button" className="k-btn k-pri k-full" onClick={retry}>
              <Icon name="retry" size={18} />
              Try again
            </button>
            {place === 'bare' ? (
              <a className="k-btn k-full" href="/">
                Go to Launches
              </a>
            ) : (
              <Link className="k-btn k-full" to="/" onClick={reset}>
                Go to Launches
              </Link>
            )}
          </>
        }
      >
        <details className="k-card k-flat acc-problem-details">
          <summary className="k-hrow k-between k-sm">
            <strong>Details</strong>
            <Icon name="chevronDown" size={18} />
          </summary>
          <p className="k-sm acc-problem-explained">
            <strong>{e.title}.</strong> <span className="k-muted">{e.text}</span>
          </p>
        </details>
        {raw && <p className="k-mono k-xs k-muted acc-problem-raw">{raw}</p>}
      </Problem>
    </Frame>
  );
}

/**
 * No connection (board Offline): said instead of an error, since nothing is wrong with the page. It
 * tries again by itself as soon as the browser is back online, and on the button any time.
 */
export function OfflinePage({ reset, place = 'shell' }: { reset: () => void; place?: ProblemPlace }) {
  const retry = useRetry(reset);
  useEffect(() => {
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  });
  return (
    <Frame place={place}>
      <Problem
        alert
        art={<Offline />}
        title="No connection"
        lead="This device is offline, or Shipcast is not reachable. It tries again on its own as soon as the connection is back."
        actions={
          <button type="button" className="k-btn k-pri k-full" onClick={retry}>
            <Icon name="retry" size={18} />
            Try again
          </button>
        }
      />
    </Frame>
  );
}
