import { createFileRoute } from '@tanstack/react-router';
import { startReddit } from '../../server/channels.server';

export const Route = createFileRoute('/auth/reddit')({
  server: { handlers: { GET: ({ request }) => startReddit(request) } },
});
