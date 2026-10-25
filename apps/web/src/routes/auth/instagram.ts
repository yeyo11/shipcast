import { createFileRoute } from '@tanstack/react-router';
import { startInstagram } from '../../server/channels.server';

export const Route = createFileRoute('/auth/instagram')({
  server: { handlers: { GET: ({ request }) => startInstagram(request) } },
});
