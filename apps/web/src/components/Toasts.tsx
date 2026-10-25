import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { explain } from './errors';

/**
 * Toasts, in Cartel's terms: a card with its outline and hard stamp shadow, and a state that is a word
 * and a shape (Done, Failed with its diamond, Waiting for you on yellow). Successes leave on their
 * own; failures stay until they are closed, since they ask for something to be done.
 */
export type ToastTone = 'ok' | 'bad' | 'wait';

export interface ToastInput {
  tone: ToastTone;
  title: string;
  text?: string;
  details?: string;
}

interface Toast extends ToastInput {
  id: number;
}

interface ToastApi {
  show(toast: ToastInput): void;
  /** A failure as the server said it, explained for a person */
  fail(raw: string): void;
  done(title: string, text?: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

const LABEL: Record<ToastTone, { word: string; pill: string }> = {
  ok: { word: 'Done', pill: 's-published' },
  bad: { word: 'Failed', pill: 's-failed' },
  wait: { word: 'Waiting for you', pill: 's-waiting' },
};

const OK_FOR_MS = 6000;

function ToastCard({ toast, close }: { toast: Toast; close: () => void }) {
  useEffect(() => {
    if (toast.tone !== 'ok') return;
    const timer = setTimeout(close, OK_FOR_MS);
    return () => clearTimeout(timer);
  }, [toast.tone, close]);
  const label = LABEL[toast.tone];
  return (
    <div className={`toast ${toast.tone}`} role={toast.tone === 'bad' ? 'alert' : 'status'}>
      <header>
        <span className={`pill ${label.pill}`}>{label.word}</span>
        <button className="toast-close" type="button" onClick={close} aria-label="Close">
          ×
        </button>
      </header>
      <p className="toast-title">{toast.title}</p>
      {toast.text && <p className="toast-text">{toast.text}</p>}
      {toast.details && (
        <details className="toast-details">
          <summary>Details</summary>
          <pre>{toast.details}</pre>
        </details>
      )}
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const remove = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const show = useCallback((toast: ToastInput) => {
    const id = next.current++;
    // At most four at once: the oldest go first
    setToasts((list) => [...list, { ...toast, id }].slice(-4));
  }, []);
  const api = useMemo<ToastApi>(
    () => ({
      show,
      fail: (raw) => show({ tone: 'bad', ...explain(raw) }),
      done: (title, text) => show({ tone: 'ok', title, text }),
    }),
    [show],
  );
  return (
    <ToastContext.Provider value={api}>
      {children}
      <section className="toasts" aria-label="Notifications">
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} close={() => remove(t.id)} />
        ))}
      </section>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast needs a ToastProvider above it');
  return api;
}
