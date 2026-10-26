/*
 * Asking for the tour from anywhere (the onboarding's end, the user menu, the command palette)
 * without importing it: the request survives one navigation in sessionStorage, and an event tells a
 * shell already on screen to start it now.
 */

const KEY = 'shipcast:tour';
export const TOUR_EVENT = 'shipcast:tour';

export function requestTour(): void {
  try {
    sessionStorage.setItem(KEY, '1');
  } catch {
    // Storage refused (a private window's quota): the event below still starts it on this page
  }
  window.dispatchEvent(new Event(TOUR_EVENT));
}

/** Whether a tour was asked for, forgetting the request so a reload does not start it again */
export function takeTourRequest(): boolean {
  try {
    const asked = sessionStorage.getItem(KEY) === '1';
    sessionStorage.removeItem(KEY);
    return asked;
  } catch {
    return false;
  }
}
