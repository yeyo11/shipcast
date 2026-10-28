import { createFileRoute } from '@tanstack/react-router';
import { appContext } from '../server/context.server';

/** A picture bigger than this is not an avatar */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * A connected account's avatar, served from the app's own address. The networks' image hosts set
 * cookies of their own (Discord's CDN, github.com's redirect) and some of their addresses expire
 * (Instagram's), so the pages ask the app, which fetches the picture the account's last check saved.
 * Behind the session like every page (start.ts); only an account's own avatar address is ever fetched.
 */
export const Route = createFileRoute('/avatars/$accountId')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const id = Number(params.accountId);
        if (!Number.isInteger(id) || id <= 0) return new Response('Not found', { status: 404 });
        const { registry } = await appContext();
        const source = (await registry.accounts.account(id))?.avatarUrl;
        if (!source || !/^https:\/\//.test(source)) return new Response('Not found', { status: 404 });
        let upstream: Response;
        try {
          upstream = await fetch(source, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
        } catch {
          return new Response('The avatar could not be fetched', { status: 502 });
        }
        const type = upstream.headers.get('content-type') ?? '';
        if (!upstream.ok || !type.startsWith('image/')) return new Response('The avatar could not be fetched', { status: 502 });
        const bytes = await upstream.arrayBuffer();
        if (bytes.byteLength > MAX_BYTES) return new Response('The avatar is too large', { status: 502 });
        return new Response(bytes, { headers: { 'content-type': type, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' } });
      },
    },
  },
});
