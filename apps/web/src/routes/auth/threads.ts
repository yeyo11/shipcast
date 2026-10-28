import { createFileRoute } from '@tanstack/react-router';
import { startOAuth } from '../../server/channels.server';

export const Route = createFileRoute('/auth/threads')({
  server: { handlers: { GET: ({ request }) => startOAuth('threads', request) } },
});
