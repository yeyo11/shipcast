import { lazy, Suspense, useEffect, useState } from 'react';
import { takeTourRequest, TOUR_EVENT } from './request';

// Loaded only when a tour starts: NextStep and its animation library stay out of every other page load
const TourRuntime = lazy(() => import('./TourRuntime'));

/** Mounted once in the shell: starts the tour when one is asked for, and unmounts it when it ends */
export function TourHost() {
  const [running, setRunning] = useState(0);

  useEffect(() => {
    if (takeTourRequest()) setRunning((n) => n + 1);
    const start = () => {
      takeTourRequest();
      setRunning((n) => n + 1);
    };
    window.addEventListener(TOUR_EVENT, start);
    return () => window.removeEventListener(TOUR_EVENT, start);
  }, []);

  if (!running) return null;
  return (
    <Suspense fallback={null}>
      <TourRuntime key={running} onEnd={() => setRunning(0)} />
    </Suspense>
  );
}
