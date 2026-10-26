import { createFileRoute, redirect } from '@tanstack/react-router';

/** The API tokens moved under Settings; the old address keeps working for bookmarks and old links */
export const Route = createFileRoute('/_app/tokens')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/api', replace: true });
  },
});
