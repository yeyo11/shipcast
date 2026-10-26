import { createFileRoute, redirect } from '@tanstack/react-router';

/** The AI settings moved under Settings; the old address keeps working for bookmarks and old links */
export const Route = createFileRoute('/_app/ai')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/ai', replace: true });
  },
});
