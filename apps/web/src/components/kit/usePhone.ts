import { useSyncExternalStore } from 'react';

/** The kit's breakpoint: the phone's layout below 960 px, the desktop's from there (kit.css) */
export const PHONE_QUERY = '(max-width: 959px)';

/**
 * Whether the window has the phone's layout, for what differs in behaviour and not only in look (a
 * bottom sheet instead of a dropdown). It follows the window's width as it changes, never the kind of
 * pointer: a narrow desktop window gets the phone's sheets, a wide touch screen the desktop's. The
 * server renders the desktop's; the phone's follows on the first paint.
 */
export function usePhone(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(PHONE_QUERY);
      query.addEventListener('change', notify);
      return () => query.removeEventListener('change', notify);
    },
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );
}
