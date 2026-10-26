import { createFileRoute } from '@tanstack/react-router';
import { finishLinkedIn } from '../../server/channels.server';

/** The network's way back; the session cookie (SameSite=Lax) comes along on the redirect */
export const Route = createFileRoute('/auth/linkedin/callback')({
  server: { handlers: { GET: ({ request }) => finishLinkedIn(request) } },
});
