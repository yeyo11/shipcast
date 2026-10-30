import { createFileRoute } from '@tanstack/react-router';
import { appContext } from '../server/context.server';

/**
 * A launch's stored file (docs/launch-store-read.md), for the launch page's media: served from the
 * media store by the app, behind the session like every page (start.ts), so a draft's image is never
 * public before it is published. Only with `launch-store-read`; the bytes are the owner's own, served
 * as they were stored, never run: no sniffing, no scripts, no frames.
 */
export const Route = createFileRoute('/media/$mediaId')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const id = Number(params.mediaId);
        const { launchRead } = await appContext();
        if (!launchRead || !Number.isInteger(id) || id <= 0) return new Response('Not found', { status: 404 });
        let file: Awaited<ReturnType<typeof launchRead.mediaFile>>;
        try {
          file = await launchRead.mediaFile(id);
        } catch {
          return new Response('The media store could not be read', { status: 502 });
        }
        if (!file) return new Response('Not found', { status: 404 });
        return new Response(new Uint8Array(file.body), {
          headers: {
            'content-type': file.mime,
            // Addressed by content: a row's bytes never change
            'cache-control': 'private, max-age=31536000, immutable',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
          },
        });
      },
    },
  },
});
