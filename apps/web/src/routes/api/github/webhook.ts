import { createFileRoute } from '@tanstack/react-router';
import { receiveWebhook } from '../../../server/webhook.server';

export const Route = createFileRoute('/api/github/webhook')({
  server: { handlers: { POST: ({ request }) => receiveWebhook(request) } },
});
