import { useSyncExternalStore } from 'react';

/** The kit's breakpoint: the phone's layout below 960 px, the desktop's from there (kit.css) */
const PHONE = '(max-width: 959px)';

/**
 * Whether the window has the phone's layout, for what differs in behaviour and not only in look (a
 * bottom sheet instead of a dropdown). The server renders the desktop's; the phone's follows on the
 * first paint.
 */
export function usePhone(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(PHONE);
      query.addEventListener('change', notify);
      return () => query.removeEventListener('change', notify);
    },
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}
