import { createFileRoute } from '@tanstack/react-router';
import { startOAuth } from '../../server/channels.server';

export const Route = createFileRoute('/auth/facebook')({
  server: { handlers: { GET: ({ request }) => startOAuth('facebook', request) } },
});
