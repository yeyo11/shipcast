import { createFileRoute } from '@tanstack/react-router';
import { handleAssistant } from '../../server/assistant';
import { assistantDeps } from '../../server/assistant.server';

/** The writing assistant: a quick action or a chat turn, streamed back as NDJSON. Session and same-origin checks apply (start.ts) */
export const Route = createFileRoute('/api/assistant')({
  server: {
    handlers: {
      POST: ({ request }) => handleAssistant(request, assistantDeps),
    },
  },
});
