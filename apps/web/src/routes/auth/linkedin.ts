import { createFileRoute } from '@tanstack/react-router';
import { startLinkedIn } from '../../server/channels.server';

export const Route = createFileRoute('/auth/linkedin')({
  server: { handlers: { GET: ({ request }) => startLinkedIn(request) } },
});
