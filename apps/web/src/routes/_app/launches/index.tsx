import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * The launches live at `/`; `/launches` is the installed app's start address and the Launches
 * shortcut (src/pwa/manifest.ts), which reads better than `/` on a launcher and keeps working if the
 * list ever moves there
 */
export const Route = createFileRoute('/_app/launches/')({
  beforeLoad: () => {
    throw redirect({ to: '/', replace: true });
  },
});
