import { createFileRoute } from '@tanstack/react-router';
import { finishReddit } from '../../server/channels.server';

/** The network's way back; the session cookie (SameSite=Lax) comes along on the redirect */
export const Route = createFileRoute('/auth/reddit/callback')({
  server: { handlers: { GET: ({ request }) => finishReddit(request) } },
});
