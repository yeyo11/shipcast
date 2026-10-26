import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useLenis } from 'lenis/react';
import { NextStepProvider, NextStepReact, useNextStep, type ArrowComponentProps, type CardComponentProps, type NavigationAdapter } from 'nextstepjs';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { listLaunches } from '../../server/launches.functions';
import { CloseIcon } from '../ui/icons';
import { notchFor, tourSteps, TOUR_NAME, type TourStep } from './steps';

/*
 * The tour, on NextStep: a spotlight per step and a Cartel card. Loaded lazily by TourHost, so its
 * animation library is only fetched by someone who asked for the tour.
 * See docs/decisions/onboarding.md
 */

/*
 * What NextStep does between two steps, read against its source (nextstepjs 2.3.0) and why this file
 * drives the moves itself:
 *
 * - `nextRoute` navigates and then moves to the next step at the first DOM mutation in which the
 *   selector exists: the page has mounted but not settled (loader data, fonts), so the spotlight is
 *   measured too early, and nothing waits for the scroll.
 * - Four code paths scroll the target with `scrollIntoView({ behavior: 'smooth' })`, and the effect
 *   that runs on every step skips its in-view check (`useInView` is given a ref that is never
 *   attached), so every step ends with a scroll that puts the target at the top of the window, racing
 *   the others; `noInViewScroll` switches that one off.
 * - The spotlight glides for 0.4s with an ease-in-out fixed in the library, while the card glides
 *   for `cardTransition`: a different duration and curve left the card ahead of the spotlight.
 * - A smooth native scroll fights Lenis, which owns the page's scrolling.
 *
 * So the steps keep their `nextRoute`/`prevRoute` as data, but the card, the arrow keys and the
 * first step go through `useConductor`: it navigates without resetting the scroll (the old card stays
 * where it is while the next page loads), waits for the target and for its box to stop moving,
 * scrolls it into the free band of the screen with Lenis, and only then tells NextStep to move
 * on, when the target is already in view and nothing is left for the library to scroll.
 */

/**
 * NextStep wants a navigation adapter. Moves between steps go through the conductor, so `push` is
 * only a safety net, and it too keeps the scroll where it is.
 */
function useTanStackAdapter(): NavigationAdapter {
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  return {
    push: (to: string) => void navigate({ to, resetScroll: false }),
    getCurrentPath: () => path,
  };
}

/** NextStep's own glide, which the card is matched to (SmoothSpotlight.js: 0.4s, ease-in-out) */
const GLIDE = { duration: 0.4, ease: 'easeInOut' } as const;

/** A card's usual height, for the room a step needs beside its target before the card is measured */
const CARD_ROOM = 280;
const CARD_GAP = 25;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** The target once the page renders it, or null after the time given */
async function targetOf(selector: string, within: number): Promise<Element | null> {
  const started = Date.now();
  for (;;) {
    const found = document.querySelector(selector);
    if (found || Date.now() - started > within) return found;
    await wait(50);
  }
}

/** Waits until the element's box has not moved for three frames, or the time is up: the page has settled */
async function settled(el: Element, within = 1500): Promise<void> {
  const started = Date.now();
  let last = '';
  let still = 0;
  while (still < 3 && Date.now() - started < within) {
    await frame();
    const r = el.getBoundingClientRect();
    const box = `${Math.round(r.top + window.scrollY)}:${Math.round(r.left)}:${Math.round(r.width)}:${Math.round(r.height)}`;
    still = box === last ? still + 1 : 0;
    last = box;
  }
}

/** A target that stays put on the screen while the page scrolls (the phone's chat bubble) */
function isFixed(el: Element): boolean {
  for (let node: Element | null = el; node && node !== document.body; node = node.parentElement) {
    if (getComputedStyle(node).position === 'fixed') return true;
  }
  return false;
}

/** The part of the window no bar covers: under a sticky header, over the phone's bottom bar */
function freeBand(): { top: number; bottom: number } {
  const header = document.querySelector('.top');
  const stuck = header && ['sticky', 'fixed'].includes(getComputedStyle(header).position);
  const bar = document.querySelector('.bottom-bar');
  const barShown = bar && bar.getClientRects().length > 0;
  return { top: stuck && header ? header.getBoundingClientRect().bottom : 0, bottom: barShown && bar ? bar.getBoundingClientRect().top : window.innerHeight };
}

/**
 * Where the page must scroll for the target and its card to be in the free band, or null when they
 * already are: a card under the target needs room below it, one above needs room above, one beside
 * it needs the target centred.
 */
function scrollFor(el: Element, side: string): number | null {
  const { top, bottom } = freeBand();
  const r = el.getBoundingClientRect();
  const card = Math.max(document.querySelector('.tour-card')?.getBoundingClientRect().height ?? 0, CARD_ROOM);
  const margin = 12;
  let delta = 0;
  if (side.startsWith('top')) {
    const wantTop = top + margin + card + CARD_GAP;
    if (r.top < wantTop || r.bottom > bottom - margin) delta = r.top - wantTop;
  } else if (side.startsWith('left') || side.startsWith('right')) {
    if (r.top < top + margin || r.bottom > bottom - margin) delta = r.top + r.height / 2 - (top + bottom) / 2;
  } else if (r.top < top + margin || r.bottom + CARD_GAP + card > bottom - margin) {
    delta = r.top - (top + margin);
  }
  const max = Math.max(document.documentElement.scrollHeight - window.innerHeight, 0);
  const to = Math.min(Math.max(window.scrollY + delta, 0), max);
  return Math.abs(to - window.scrollY) < 2 ? null : to;
}

type Lenis = NonNullable<ReturnType<typeof useLenis>>;

/** Scrolls the page and resolves when it arrives: through Lenis when it runs, natively otherwise, never animated for reduced motion */
async function scrollPage(to: number, lenis: Lenis | undefined): Promise<void> {
  const reduced = prefersReducedMotion();
  if (lenis && !reduced) {
    await Promise.race([
      new Promise<void>((resolve) => lenis.scrollTo(to, { duration: 0.8, force: true, onComplete: () => resolve() })),
      wait(1600),
    ]);
  } else {
    window.scrollTo({ top: to, behavior: reduced ? 'auto' : 'smooth' });
    if (!reduced) await Promise.race([new Promise<void>((resolve) => window.addEventListener('scrollend', () => resolve(), { once: true })), wait(1000)]);
  }
  await frame();
}

interface Conductor {
  /** Moves one step on (1) or back (-1); ends the tour past the last */
  go(by: 1 | -1): void;
  /** A move is under way: the buttons wait for it */
  moving: boolean;
}

const ConductorContext = createContext<Conductor>({ go: () => {}, moving: false });

/**
 * Brings the tour to a step: its page, its target settled and in the free band. Resolves when
 * NextStep may be told to show it.
 */
function useReveal(steps: TourStep[]) {
  const navigate = useNavigate();
  const lenis = useLenis();
  return useCallback(
    async (index: number, alive: () => boolean) => {
      const step = steps[index];
      if (!step) return;
      // Without resetting the scroll: the card and spotlight stay where they were while the next page loads
      if (window.location.pathname !== step.route) await navigate({ to: step.route, resetScroll: false });
      if (!step.selector || !alive()) return;
      const el = await targetOf(step.selector, 6000);
      if (!el || !alive()) return;
      await settled(el);
      if (!alive() || isFixed(el)) return;
      const to = scrollFor(el, step.side ?? 'bottom');
      if (to !== null) await scrollPage(to, lenis);
    },
    [steps, navigate, lenis],
  );
}

/**
 * The pointer is part of the card: a notch on the edge facing the target, in the card's own fill and
 * outline (features.css). NextStep's positioning style is left out on purpose: it centres its caret
 * on the target, which for a full-width heading lands at the card's far corner, over the text.
 */
function TourNotch({ side }: ArrowComponentProps) {
  const notch = notchFor(side);
  if (!notch) return null;
  return <span className="tour-notch" data-edge={notch.edge} data-align={notch.align} aria-hidden="true" />;
}

/**
 * The step's card: a non-modal dialog that takes the focus on every step, so a keyboard or screen
 * reader user hears the step and can act on it. NextStep's own keys still work: the arrows move,
 * Escape ends the tour.
 */
function TourCard({ step, currentStep, totalSteps, skipTour, arrow }: CardComponentProps) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const { go, moving } = useContext(ConductorContext);
  const last = currentStep === totalSteps - 1;
  useEffect(() => {
    // preventScroll: focusing a card that is off-screen would otherwise jump the page to it, instantly
    ref.current?.focus({ preventScroll: true });
  }, [currentStep]);
  return (
    <div ref={ref} className="tour-card" role="dialog" aria-modal="false" aria-labelledby={titleId} aria-busy={moving} tabIndex={-1}>
      <div className="tour-card-head">
        <span className="tour-count">
          {currentStep + 1} / {totalSteps}
        </span>
        <button type="button" className="ui-icon-button tour-close" onClick={skipTour} aria-label="End the tour">
          <CloseIcon size={18} />
        </button>
      </div>
      <h2 id={titleId} className="tour-title">
        {step.title}
      </h2>
      <div className="tour-text">{step.content}</div>
      <div className="tour-progress" aria-hidden="true">
        <span style={{ width: `${((currentStep + 1) / totalSteps) * 100}%` }} />
      </div>
      <div className="row tour-actions">
        {currentStep > 0 && (
          <button type="button" className="btn btn-small" onClick={() => go(-1)} disabled={moving}>
            Back
          </button>
        )}
        <button type="button" className="btn btn-primary btn-small" onClick={() => go(1)} disabled={moving}>
          {last ? 'Done' : 'Next'}
        </button>
        {!last && (
          <button type="button" className="btn-link tour-skip" onClick={skipTour}>
            Skip the tour
          </button>
        )}
      </div>
      <p className="visually-hidden">Arrow keys move between steps; Escape ends the tour.</p>
      {arrow}
    </div>
  );
}

/**
 * Inside NextStep's provider: goes to the first step and starts the tour, and moves between steps
 * for the card and the arrow keys. NextStep's own keys are blocked on every step (they would move
 * without waiting for the page), and these do the same thing through `useReveal`.
 */
function Stage({ steps, onEnd, children }: { steps: TourStep[]; onEnd: () => void; children: () => ReactNode }) {
  const { startNextStep, setCurrentStep, closeNextStep, currentStep } = useNextStep();
  const reveal = useReveal(steps);
  const [moving, setMoving] = useState(false);
  const busy = useRef(false);
  const alive = useRef(true);
  const at = useRef(0);
  at.current = currentStep;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The first step: its page and target first, so the tour opens on the target and not on a scroll
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    busy.current = true;
    void reveal(0, () => alive.current).then(() => {
      busy.current = false;
      if (alive.current) startNextStep(TOUR_NAME);
    });
  }, [reveal, startNextStep]);

  const go = useCallback(
    (by: 1 | -1) => {
      if (busy.current) return;
      const to = at.current + by;
      if (to < 0) return;
      if (to >= steps.length) {
        closeNextStep();
        onEnd();
        return;
      }
      busy.current = true;
      setMoving(true);
      void reveal(to, () => alive.current)
        .then(async () => {
          if (!alive.current) return;
          setCurrentStep(to);
          // Let the glide finish before the next click is taken
          await wait(GLIDE.duration * 1000 + 50);
        })
        .finally(() => {
          busy.current = false;
          if (alive.current) setMoving(false);
        });
    },
    [steps, reveal, setCurrentStep, closeNextStep, onEnd],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]');
      if (event.key === 'Escape') {
        closeNextStep();
        onEnd();
      } else if (!typing && event.key === 'ArrowRight') go(1);
      else if (!typing && event.key === 'ArrowLeft') go(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, closeNextStep, onEnd]);

  // NextStep lays the spotlight out in page coordinates: a target fixed to the screen (the phone's
  // bubble) would drift from it as the page scrolls, and NextStep re-measures on a resize
  useEffect(() => {
    const selector = steps[currentStep]?.selector;
    if (!selector) return;
    let pending = 0;
    const follow = () => {
      const el = document.querySelector(selector);
      if (!el || !isFixed(el)) return;
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    };
    window.addEventListener('scroll', follow, { passive: true });
    return () => {
      window.removeEventListener('scroll', follow);
      cancelAnimationFrame(pending);
    };
  }, [steps, currentStep]);

  const conductor = useMemo(() => ({ go, moving }), [go, moving]);
  return <ConductorContext.Provider value={conductor}>{children()}</ConductorContext.Provider>;
}

export default function TourRuntime({ onEnd }: { onEnd: () => void }) {
  // The launch page the tour shows is the newest launch's; without one, that step is left out
  const [launchId, setLaunchId] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    void listLaunches()
      .then((data) => setLaunchId(data.launches[0]?.id ?? null))
      .catch(() => setLaunchId(null));
  }, []);
  const steps = useMemo(() => (launchId === undefined ? [] : tourSteps({ launchId })), [launchId]);
  // Keys are the conductor's; see Stage
  const forNextStep = useMemo(() => steps.map((step) => ({ ...step, blockKeyboardControl: true })), [steps]);
  const reduced = prefersReducedMotion();
  if (steps.length === 0) return null;
  return (
    <NextStepProvider>
      <Stage steps={steps} onEnd={onEnd}>
        {() => (
          <NextStepReact
            steps={[{ tour: TOUR_NAME, steps: forNextStep }]}
            cardComponent={TourCard}
            arrowComponent={TourNotch}
            navigationAdapter={useTanStackAdapter}
            cardTransition={reduced ? { duration: 0 } : GLIDE}
            shadowRgb="10, 10, 10"
            shadowOpacity="0.6"
            disableConsoleLogs
            scrollToTop={false}
            noInViewScroll
            onComplete={onEnd}
            onSkip={onEnd}
          >
            {null}
          </NextStepReact>
        )}
      </Stage>
    </NextStepProvider>
  );
}
