import { createFileRoute } from '@tanstack/react-router';
import { finishGitHubSignIn } from '../../server/auth.server';

export const Route = createFileRoute('/auth/github/callback')({
  server: { handlers: { GET: ({ request }) => finishGitHubSignIn(request) } },
});
