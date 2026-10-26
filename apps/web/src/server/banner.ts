/*
 * The page banner's size, one preference for every page: full (the band with its illustration and
 * lead) or compact (a slim title strip). It lives in a cookie rather than in the browser's storage
 * so the server renders the right one and the page never flashes the other first.
 */

export type BannerState = 'full' | 'compact';

export const BANNER_COOKIE = 'sc_banner';
/** A year: a preference, not a session */
export const BANNER_MAX_AGE = 365 * 86_400;

/** The value a cookie header holds for the banner; anything else, or nothing, is the full banner */
export function readBanner(cookieHeader: string | null | undefined): BannerState {
  for (const part of (cookieHeader ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === BANNER_COOKIE) return rest.join('=').trim() === 'compact' ? 'compact' : 'full';
  }
  return 'full';
}

/** What `document.cookie` is set to. Not HttpOnly on purpose: the page writes it when the owner toggles */
export function bannerCookie(state: BannerState): string {
  return `${BANNER_COOKIE}=${state}; Path=/; Max-Age=${BANNER_MAX_AGE}; SameSite=Lax`;
}
