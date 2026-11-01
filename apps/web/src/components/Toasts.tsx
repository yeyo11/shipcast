import { Toast } from '@base-ui/react/toast';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { explain } from './errors';
import { Icon } from './kit/Icon';

/**
 * Toasts (board Toasts): a card with its outline and hard stamp shadow, and a state that is a word
 * and a shape (Done, Failed with its diamond, Waiting for you on yellow). Successes and notices leave
 * on their own; failures stay until they are closed, since they ask for something to be done.
 *
 * Base UI's Toast does the rest: the viewport is a landmark F6 jumps to, timers pause while the
 * pointer or the focus is on a toast, a toast can be swiped away, and it animates out before it is
 * removed. The API the pages use (`useToast().show/done/fail`) is the one from before Base UI.
 */
export type ToastTone = 'ok' | 'bad' | 'wait';

export interface ToastInput {
  tone: ToastTone;
  title: string;
  text?: string;
  details?: string;
}

interface ToastApi {
  show(toast: ToastInput): void;
  /** A failure as the server said it, explained for a person */
  fail(raw: string): void;
  done(title: string, text?: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

const LABEL: Record<ToastTone, { word: string; pill: string; card: string }> = {
  ok: { word: 'Done', pill: 'k-p-pub', card: '' },
  bad: { word: 'Failed', pill: 'k-p-fail', card: ' k-fail' },
  wait: { word: 'Waiting for you', pill: 'k-p-wait', card: ' k-wait' },
};

const OK_FOR_MS = 6000;
/** A notice that waits for the owner stays longer than a success, and leaves with a swipe too */
const WAIT_FOR_MS = 12000;
/** At most four at once: older ones wait, hidden, until a newer one leaves */
const LIMIT = 4;

const isTone = (type: string | undefined): type is ToastTone => type === 'ok' || type === 'bad' || type === 'wait';

function ToastList() {
  const { toasts } = Toast.useToastManager<{ details?: string }>();
  return toasts.map((toast) => {
    const tone = isTone(toast.type) ? toast.type : 'ok';
    const label = LABEL[tone];
    const details = toast.data?.details;
    return (
      <Toast.Root key={toast.id} toast={toast} className={`k-toast home-toast${label.card}`} swipeDirection={['right', 'down']}>
        <Toast.Content className="k-stack k-g6">
          <div className="k-hrow k-g8">
            <span className={`k-pill ${label.pill}`}>{label.word}</span>
            <Toast.Title className="k-sm k-grow home-toast-title" render={<strong />} />
            {tone !== 'wait' && (
              <Toast.Close className="k-btn k-icon k-sm k-ghost home-toast-close" aria-label="Close">
                <Icon name="close" size={20} />
              </Toast.Close>
            )}
          </div>
          {toast.description && <Toast.Description className={`k-xs${tone === 'wait' ? '' : ' k-muted'} home-toast-text`} />}
          {details && (
            <details className="home-toast-details">
              <summary className="k-xs">Details</summary>
              <pre>{details}</pre>
            </details>
          )}
        </Toast.Content>
      </Toast.Root>
    );
  });
}

export function ToastProvider({ children }: { children: ReactNode }) {
  // One manager per provider, made once: the API built on it keeps its identity across renders, so
  // pages can list it in an effect's dependencies without the effect running again
  const [manager] = useState(() => Toast.createToastManager<{ details?: string }>());
  const api = useMemo<ToastApi>(() => {
    const show = (toast: ToastInput) => {
      manager.add({
        type: toast.tone,
        title: toast.title,
        description: toast.text,
        timeout: toast.tone === 'ok' ? OK_FOR_MS : toast.tone === 'wait' ? WAIT_FOR_MS : 0,
        // A failure interrupts the screen reader; the rest wait their turn
        priority: toast.tone === 'bad' ? 'high' : 'low',
        data: { details: toast.details },
      });
    };
    return {
      show,
      fail: (raw) => show({ tone: 'bad', ...explain(raw) }),
      done: (title, text) => show({ tone: 'ok', title, text }),
    };
  }, [manager]);
  // In development only: a way for the pixel checks to raise each kind of toast (board Toasts)
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __shipcastToast?: ToastApi }).__shipcastToast = api;
  }, [api]);
  return (
    <Toast.Provider limit={LIMIT} toastManager={manager}>
      <ToastContext.Provider value={api}>{children}</ToastContext.Provider>
      <Toast.Portal>
        <Toast.Viewport className="home-toasts" aria-label="Notifications">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast needs a ToastProvider above it');
  return api;
}
