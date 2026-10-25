import { createFileRoute } from '@tanstack/react-router';
import { signOut } from '../../server/auth.server';

export const Route = createFileRoute('/auth/logout')({
  server: { handlers: { POST: () => signOut() } },
});
