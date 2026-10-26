import { createFileRoute } from '@tanstack/react-router';
import { startThreads } from '../../server/channels.server';

export const Route = createFileRoute('/auth/threads')({
  server: { handlers: { GET: ({ request }) => startThreads(request) } },
});
