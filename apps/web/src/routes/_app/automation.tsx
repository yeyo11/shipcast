import { createFileRoute, redirect } from '@tanstack/react-router';

/** Automation moved under Settings; the old address keeps working for bookmarks and old links */
export const Route = createFileRoute('/_app/automation')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/automation', replace: true });
  },
});
