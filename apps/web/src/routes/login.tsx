import { createFileRoute } from '@tanstack/react-router';
import { SignIn as SignInArt } from '../components/illustrations';
import { safeNext } from '../server/next-path';

export const Route = createFileRoute('/login')({
  head: () => ({ meta: [{ title: 'Sign in · Shipcast' }] }),
  // `next`: the page the session ended on, so signing in again lands back there
  validateSearch: (search: Record<string, unknown>): { next?: string } => {
    const next = safeNext(typeof search.next === 'string' ? search.next : undefined);
    return next ? { next } : {};
  },
  component: SignIn,
});

function SignIn() {
  const { next } = Route.useSearch();
  return (
    <main className="signin">
      <div className="poster">
        <SignInArt width={300} className="signin-art" />
        <h1 className="ph">
          Ship<span>cast</span>
        </h1>
        {next ? (
          <p>Your session ended. Sign in again and you go straight back to where you were.</p>
        ) : (
          <p>Your launches, their channels and how each one did. Only its owner gets in.</p>
        )}
        <a className="btn btn-primary" href={next ? `/auth/github?next=${encodeURIComponent(next)}` : '/auth/github'}>
          Sign in with GitHub
        </a>
      </div>
    </main>
  );
}
