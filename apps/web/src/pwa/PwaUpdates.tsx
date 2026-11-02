import { useEffect } from 'react';
import { useToast } from '../components/Toasts';

/** How often an app left open looks for a new deploy, besides each time it comes back to the screen */
const CHECK_EVERY_MS = 60 * 60_000;

/**
 * Registers the service worker (docs/decisions/pwa.md) and offers its updates. A new build's worker
 * installs in the background and waits; the owner gets "New version available" with Reload, and only
 * that swaps it in and reloads this tab. Another tab swapped meanwhile says so and waits for its own
 * Reload, so no page is ever reloaded in the middle of an edit. Builds only: development has no worker.
 */
export function PwaUpdates() {
  const toast = useToast();
  useEffect(() => {
    if (import.meta.env.DEV || !('serviceWorker' in navigator)) return;
    const sw = navigator.serviceWorker;
    let offered = false;
    let reloading = false;
    let registration: ServiceWorkerRegistration | undefined;

    const offer = (waiting: ServiceWorker) => {
      if (offered) return;
      offered = true;
      toast.show({
        tone: 'wait',
        title: 'New version available',
        text: 'Reload to use it, once what you are writing is saved.',
        stay: true,
        action: {
          label: 'Reload',
          onClick: () => {
            reloading = true;
            waiting.postMessage({ type: 'SKIP_WAITING' });
          },
        },
      });
    };
    const watch = (worker: ServiceWorker | null) => {
      worker?.addEventListener('statechange', () => {
        // Installed beside a worker already in charge: an update, not the first install
        if (worker.state === 'installed' && sw.controller) offer(worker);
      });
    };
    const onControllerChange = () => {
      if (reloading) {
        window.location.reload();
        return;
      }
      toast.show({ tone: 'wait', title: 'Shipcast was updated', text: 'Reload this tab to use the new version.', stay: true, action: { label: 'Reload', onClick: () => window.location.reload() } });
    };
    const check = () => {
      if (document.visibilityState === 'visible') void registration?.update().catch(() => undefined);
    };

    sw.addEventListener('controllerchange', onControllerChange);
    document.addEventListener('visibilitychange', check);
    const timer = window.setInterval(check, CHECK_EVERY_MS);
    // updateViaCache none: the worker's script is always asked of the server, never the HTTP cache
    void sw
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then((found) => {
        registration = found;
        if (found.waiting && sw.controller) offer(found.waiting);
        watch(found.installing);
        found.addEventListener('updatefound', () => watch(found.installing));
      })
      .catch(() => undefined);
    return () => {
      sw.removeEventListener('controllerchange', onControllerChange);
      document.removeEventListener('visibilitychange', check);
      window.clearInterval(timer);
    };
  }, [toast]);
  return null;
}
