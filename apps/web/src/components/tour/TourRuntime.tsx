import { useNavigate, useRouterState } from '@tanstack/react-router';
import { NextStepProvider, NextStepReact, useNextStep, type CardComponentProps, type NavigationAdapter } from 'nextstepjs';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { listLaunches } from '../../server/launches.functions';
import { CloseIcon } from '../ui/icons';
import { tourSteps, TOUR_NAME, type TourStep } from './steps';

/*
 * The tour, on NextStep: a spotlight per step and a Cartel card. Loaded lazily by TourHost, so its
 * animation library is only fetched by someone who asked for the tour.
 * See docs/decisions/onboarding.md
 */

/** NextStep navigates through an adapter: this one is TanStack Router's, so a step's route is a client navigation */
function useTanStackAdapter(): NavigationAdapter {
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  return {
    push: (to: string) => void navigate({ to }),
    getCurrentPath: () => path,
  };
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The step's card: a non-modal dialog that takes the focus on every step, so a keyboard or screen
 * reader user hears the step and can act on it. NextStep's own keys still work: the arrows move,
 * Escape ends the tour.
 */
function TourCard({ step, currentStep, totalSteps, nextStep, prevStep, skipTour, arrow }: CardComponentProps) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const last = currentStep === totalSteps - 1;
  useEffect(() => {
    ref.current?.focus();
  }, [currentStep]);
  return (
    <div ref={ref} className="tour-card" role="dialog" aria-modal="false" aria-labelledby={titleId} tabIndex={-1}>
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
          <button type="button" className="btn btn-small" onClick={prevStep}>
            Back
          </button>
        )}
        <button type="button" className="btn btn-primary btn-small" onClick={nextStep}>
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

/** Goes to the first step's page, waits for its target, and starts the tour */
function Starter({ steps }: { steps: TourStep[] }) {
  const { startNextStep } = useNextStep();
  const navigate = useNavigate();
  useEffect(() => {
    const first = steps[0];
    if (!first) return;
    let stopped = false;
    void navigate({ to: first.route }).then(() => {
      const started = Date.now();
      const tick = () => {
        if (stopped) return;
        if (!first.selector || document.querySelector(first.selector) || Date.now() - started > 4000) startNextStep(TOUR_NAME);
        else window.setTimeout(tick, 100);
      };
      tick();
    });
    return () => {
      stopped = true;
    };
  }, [steps, navigate, startNextStep]);
  return null;
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
  const reduced = prefersReducedMotion();
  if (steps.length === 0) return null;
  return (
    <NextStepProvider>
      <NextStepReact
        steps={[{ tour: TOUR_NAME, steps }]}
        cardComponent={TourCard}
        navigationAdapter={useTanStackAdapter}
        cardTransition={reduced ? { duration: 0 } : { ease: 'easeOut', duration: 0.25 }}
        shadowRgb="10, 10, 10"
        shadowOpacity="0.6"
        disableConsoleLogs
        scrollToTop={false}
        onComplete={onEnd}
        onSkip={onEnd}
      >
        <Starter steps={steps} />
      </NextStepReact>
    </NextStepProvider>
  );
}
