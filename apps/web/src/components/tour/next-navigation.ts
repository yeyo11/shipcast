/*
 * Stands in for `next/navigation`, which nextstepjs's entry point imports for its Next.js wrapper.
 * The app only renders the router-agnostic NextStepReact with its own TanStack Router adapter, so
 * these are never called; they exist so the bundle resolves (vite.config.ts aliases the module here).
 */

const unused = (): never => {
  throw new Error('next/navigation is not available: the tour uses TanStack Router');
};

export const useRouter = unused;
export const usePathname = unused;
