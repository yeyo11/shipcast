import { createFileRoute } from '@tanstack/react-router';
import { GLYPHS } from '../components/kit/glyphs';
import { Icon } from '../components/kit/Icon';
import { SignIn as SignInArt } from '../components/illustrations';
import { safeWas, whereFrom } from '../components/where-from';
import { safeNext } from '../server/next-path';

export const Route = createFileRoute('/login')({
  head: () => ({ meta: [{ title: 'Sign in · Shipcast' }] }),
  // `next`: the page the session ended on, so signing in again lands back there; `was`: its name in words
  validateSearch: (search: Record<string, unknown>): { next?: string; was?: string } => {
    const next = safeNext(typeof search.next === 'string' ? search.next : undefined);
    const was = next ? safeWas(search.was) : undefined;
    return { ...(next && { next }), ...(was && { was }) };
  },
  component: SignIn,
});

const LEAD = {
  fresh: 'Your launches, their channels and how each one did. Only its owner gets in.',
  expired: 'Your session ended. Sign in again and you go straight back to where you were.',
};

/**
 * Signing in (boards Login, LoginExpired and DesktopLogin): the "Wanted" poster on a yellow band and
 * the one way in. When the session ended on a page, it says so and where that page was; signing in
 * goes straight back there.
 */
function SignIn() {
  const { next, was } = Route.useSearch();
  const href = next ? `/auth/github?next=${encodeURIComponent(next)}` : '/auth/github';
  const where = next ? (was ?? whereFrom(next)) : undefined;
  const lead = next ? LEAD.expired : LEAD.fresh;
  return (
    <main className="acc-login" id="main">
      <div className="acc-login-band">
        <SignInArt className="acc-login-art" />
      </div>
      <div className="acc-login-body">
        <h1 className="k-d acc-login-title">
          Ship<span>cast</span>
        </h1>
        <p className="k-lead acc-login-lead">{lead}</p>
        <a className="k-btn k-pri k-full acc-login-go" href={href}>
          <svg className="acc-login-glyph" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d={GLYPHS.github} />
          </svg>
          Sign in with GitHub
        </a>
        {where && (
          <p className="k-hrow k-g8 k-xs k-muted acc-login-was">
            <Icon name="clock" size={16} />
            You were on {where}
          </p>
        )}
      </div>
    </main>
  );
}
