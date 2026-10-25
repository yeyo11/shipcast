import { createFileRoute } from '@tanstack/react-router';
import { appContext } from '../../server/context.server';

/** Public and silent: it says only that the app answers, and starting its context starts the rounds */
export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: () => {
        appContext();
        return new Response('ok', { headers: { 'content-type': 'text/plain' } });
      },
    },
  },
});
