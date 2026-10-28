import { createFileRoute } from '@tanstack/react-router';

/** The process is up: nothing is touched, so a slow database never gets a live process restarted */
export const Route = createFileRoute('/livez')({
  server: { handlers: { GET: () => new Response('ok', { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } }) } },
});
