import { createFileRoute } from '@tanstack/react-router';
import { startGitHubSignIn } from '../../server/auth.server';

export const Route = createFileRoute('/auth/github')({
  server: { handlers: { GET: ({ request }) => startGitHubSignIn(request) } },
});
