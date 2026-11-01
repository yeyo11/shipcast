import { createFileRoute } from '@tanstack/react-router';
import { mediaKey } from '@shipcast/engine';
import { appContext } from '../server/context.server';

/**
 * An uploaded image (an article's on Write, a launch's source), for the editor to show before the
 * site has it: served from the media store by the app, behind the session like every page
 * (start.ts), and only a file recorded as an upload. As /media/$mediaId: the bytes as stored, never
 * run. See docs/decisions/rich-editor.md
 */
export const Route = createFileRoute('/uploads/$sha256')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (!/^[0-9a-f]{64}$/.test(params.sha256)) return new Response('Not found', { status: 404 });
        const { registry, media } = await appContext();
        const upload = await registry.sources.upload(params.sha256);
        if (!upload) return new Response('Not found', { status: 404 });
        let file: Awaited<ReturnType<typeof media.get>>;
        try {
          file = await media.get(mediaKey(params.sha256));
        } catch {
          return new Response('The media store could not be read', { status: 502 });
        }
        if (!file) return new Response('Not found', { status: 404 });
        return new Response(new Uint8Array(file.body), {
          headers: {
            'content-type': upload.mime,
            'cache-control': 'private, max-age=31536000, immutable',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
          },
        });
      },
    },
  },
});
