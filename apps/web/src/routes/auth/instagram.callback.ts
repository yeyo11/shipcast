import { createFileRoute } from '@tanstack/react-router';
import { finishInstagram } from '../../server/channels.server';

/** The network's way back; the session cookie (SameSite=Lax) comes along on the redirect */
export const Route = createFileRoute('/auth/instagram/callback')({
  server: { handlers: { GET: ({ request }) => finishInstagram(request) } },
});
