import { createFileRoute } from '@tanstack/react-router';
import { startMastodon } from '../../server/channels.server';

export const Route = createFileRoute('/auth/mastodon')({
  server: { handlers: { GET: ({ request }) => startMastodon(request) } },
});
