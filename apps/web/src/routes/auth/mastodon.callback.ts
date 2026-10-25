import { createFileRoute } from '@tanstack/react-router';
import { finishMastodon } from '../../server/channels.server';

/** The network's way back; the session cookie (SameSite=Lax) comes along on the redirect */
export const Route = createFileRoute('/auth/mastodon/callback')({
  server: { handlers: { GET: ({ request }) => finishMastodon(request) } },
});
