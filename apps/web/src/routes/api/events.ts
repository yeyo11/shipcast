import { createHash } from 'node:crypto';
import { createFileRoute } from '@tanstack/react-router';
import { appContext } from '../../server/context.server';
import { cookieOf, SESSION_COOKIE } from '../../server/session.server';

/**
 * The tab's event stream (runtime's realtime/stream.ts has the protocol). Behind the session like
 * every page (start.ts refuses it without one); the cookie's digest names the session for the cap on
 * streams, never the cookie itself. With `realtime-ui` off there is nothing to stream: 404, and the
 * pages poll as they always did.
 */
export const Route = createFileRoute('/api/events')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { live } = await appContext();
        if (!live) return new Response('Live updates are off', { status: 404 });
        const session = createHash('sha256')
          .update(cookieOf(request, SESSION_COOKIE) ?? '')
          .digest('base64url');
        return live.open(request, session);
      },
    },
  },
});
