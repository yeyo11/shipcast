import { createFileRoute } from '@tanstack/react-router';
import { startOAuth } from '../../server/channels.server';

export const Route = createFileRoute('/auth/reddit')({
  server: { handlers: { GET: ({ request }) => startOAuth('reddit', request) } },
});
