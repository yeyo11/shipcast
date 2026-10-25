import { createFileRoute } from '@tanstack/react-router';
import { SignIn as SignInArt } from '../components/illustrations';

export const Route = createFileRoute('/login')({
  head: () => ({ meta: [{ title: 'Sign in · Shipcast' }] }),
  component: SignIn,
});

function SignIn() {
  return (
    <main className="signin">
      <div className="poster">
        <SignInArt width={300} className="signin-art" />
        <h1 className="ph">
          Ship<span>cast</span>
        </h1>
        <p>Your launches, their channels and how each one did. Only its owner gets in.</p>
        <a className="btn btn-primary" href="/auth/github">
          Sign in with GitHub
        </a>
      </div>
    </main>
  );
}
