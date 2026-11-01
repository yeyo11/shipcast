import { createFileRoute } from '@tanstack/react-router';
import { pageUpload } from '../../../server/sources-api';
import { uploadSource } from '../../../server/work.server';

/**
 * An image for a launch made from sources, uploaded by the app's page: the file's
 * bytes as the body, behind the session and the same-origin check like every page call (start.ts).
 * Not a server function: those parse a multipart body whole before any check could refuse it.
 */
export const Route = createFileRoute('/api/sources/media')({
  server: {
    handlers: {
      POST: async ({ request }) => pageUpload(request, { upload: uploadSource }),
    },
  },
});
