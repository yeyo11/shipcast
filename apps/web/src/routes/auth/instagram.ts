import { createFileRoute } from '@tanstack/react-router';
import { startOAuth } from '../../server/channels.server';

export const Route = createFileRoute('/auth/instagram')({
  server: { handlers: { GET: ({ request }) => startOAuth('instagram', request) } },
});
