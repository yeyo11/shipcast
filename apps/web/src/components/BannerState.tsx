import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { bannerCookie, type BannerState } from '../server/banner';

/*
 * One banner size for every page (docs/web-app.md): the shell gets it from the cookie on the server,
 * every PageHead and SectionHead reads it here, and toggling it on one page keeps it on the next.
 */

const Context = createContext<{ state: BannerState; set: (next: BannerState) => void }>({ state: 'full', set: () => undefined });

export function BannerProvider({ initial, children }: { initial: BannerState; children: ReactNode }) {
  const [state, setState] = useState<BannerState>(initial);
  const set = useCallback((next: BannerState) => {
    setState(next);
    document.cookie = bannerCookie(next);
  }, []);
  return <Context.Provider value={{ state, set }}>{children}</Context.Provider>;
}

export function useBannerState(): { compact: boolean; toggle: () => void } {
  const { state, set } = useContext(Context);
  return { compact: state === 'compact', toggle: () => set(state === 'compact' ? 'full' : 'compact') };
}
