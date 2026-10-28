import { createFileRoute } from '@tanstack/react-router';
import { startOAuth } from '../../server/channels.server';

export const Route = createFileRoute('/auth/linkedin')({
  server: { handlers: { GET: ({ request }) => startOAuth('linkedin', request) } },
});
