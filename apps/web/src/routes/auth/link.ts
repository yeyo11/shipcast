import { createFileRoute } from '@tanstack/react-router';
import { redeemConsoleLink } from '../../server/auth.server';

export const Route = createFileRoute('/auth/link')({
  server: { handlers: { GET: ({ request }) => redeemConsoleLink(request) } },
});
