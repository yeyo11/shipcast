import { ReactLenis } from 'lenis/react';
import { useEffect, useState } from 'react';

/**
 * Smooth scrolling for the whole page, through Lenis. It stays off for anyone who asks the system for
 * reduced motion, and until the page has hydrated, so the server's HTML scrolls like any page.
 * Nested scrollers (a draft's textarea, a toast's details) keep their own native scrolling.
 */
export function SmoothScroll() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setOn(!reduce.matches);
    update();
    reduce.addEventListener('change', update);
    return () => reduce.removeEventListener('change', update);
  }, []);
  return on ? <ReactLenis root options={{ lerp: 0.12, anchors: true, allowNestedScroll: true }} /> : null;
}
