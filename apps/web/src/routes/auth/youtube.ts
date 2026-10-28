import { createFileRoute } from '@tanstack/react-router';
import { startOAuth } from '../../server/channels.server';

export const Route = createFileRoute('/auth/youtube')({
  server: { handlers: { GET: ({ request }) => startOAuth('youtube', request) } },
});
