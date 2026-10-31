import { createFileRoute, notFound } from '@tanstack/react-router';
import { NotFoundPage } from '../../components/Problems';

/**
 * Any address no page of the app answers (board NotFound): inside the shell, so its bars stay and
 * every section is a tap away. Thrown as a not-found, so the server answers it with a 404.
 */
export const Route = createFileRoute('/_app/$')({
  head: () => ({ meta: [{ title: 'Nothing here · Shipcast' }] }),
  loader: () => {
    throw notFound();
  },
  notFoundComponent: () => <NotFoundPage />,
});
