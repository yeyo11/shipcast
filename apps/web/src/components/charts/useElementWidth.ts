import { useCallback, useState } from 'react';

/**
 * An element's width, kept current as it resizes, so a chart draws to its container from 320 px up.
 * Zero until the element is in the page: on the server and in the first paint nothing is measured,
 * and the chart keeps its height empty rather than drawing at a guessed width.
 */
export function useElementWidth<E extends HTMLElement>(): [(element: E | null) => void, number] {
  const [width, setWidth] = useState(0);
  // A callback ref with React 19's cleanup: the observer follows the element, not the render
  const ref = useCallback((element: E | null) => {
    if (!element) return;
    setWidth(Math.floor(element.getBoundingClientRect().width));
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** An element's width and height, kept current: for a chart whose height the stylesheet sets per layout */
export function useElementSize<E extends HTMLElement>(): [(element: E | null) => void, { width: number; height: number }] {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const ref = useCallback((element: E | null) => {
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setSize({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}
