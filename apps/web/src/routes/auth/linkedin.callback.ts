import { createFileRoute } from '@tanstack/react-router';
import { finishOAuth } from '../../server/channels.server';

/** The network's way back; the session cookie (SameSite=Lax) comes along on the redirect */
export const Route = createFileRoute('/auth/linkedin/callback')({
  server: { handlers: { GET: ({ request }) => finishOAuth('linkedin', request) } },
});
