import { useEffect } from 'react';
import { MISSING_IMAGE } from './images';

/**
 * An image that fails to load inside `element` (its file gone from the media store, the store not
 * answering) shows `MISSING_IMAGE` instead of the browser's broken icon: one listener in the capture
 * phase, since `error` does not bubble, and a look at the images that failed before it was there (a
 * page the server rendered).
 */
export function useMissingImages(element: HTMLElement | null | undefined): void {
  useEffect(() => {
    if (!element) return;
    const replace = (img: HTMLImageElement) => {
      if (img.getAttribute('src') !== MISSING_IMAGE) img.src = MISSING_IMAGE;
    };
    const onError = (event: Event) => {
      if (event.target instanceof HTMLImageElement) replace(event.target);
    };
    element.addEventListener('error', onError, true);
    for (const img of element.querySelectorAll('img')) if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) replace(img);
    return () => element.removeEventListener('error', onError, true);
  }, [element]);
}
