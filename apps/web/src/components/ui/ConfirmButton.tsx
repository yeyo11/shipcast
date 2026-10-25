import { AlertDialog } from '@base-ui/react/alert-dialog';
import { useState, type ReactNode } from 'react';

export interface ConfirmButtonProps {
  /** The button's own label, and what it looks like (any `.btn` classes) */
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  /** The question, as a short title ("Disconnect Mastodon?") */
  title: ReactNode;
  /** What happens if the owner goes on, in a sentence or two */
  description: ReactNode;
  /** The confirming button's label: the verb again ("Disconnect"), never "OK" */
  confirm: string;
  /** Red for what cannot be undone, yellow for a change that only needs care */
  tone?: 'danger' | 'primary';
  onConfirm: () => void | Promise<unknown>;
}

/**
 * A button that asks before it acts: Base UI's AlertDialog in place of `window.confirm`, so the
 * question looks like the app, names the consequence, and focus comes back to the button after.
 * The safe choice (Cancel) has the focus when it opens, so Enter never confirms by accident.
 */
export function ConfirmButton({ children, className = 'btn', disabled, title, description, confirm, tone = 'danger', onConfirm }: ConfirmButtonProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <AlertDialog.Trigger className={className} disabled={disabled}>
        {children}
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="ui-backdrop" />
        <AlertDialog.Viewport className="ui-dialog-viewport">
          <AlertDialog.Popup className={`ui-dialog ui-alert${tone === 'danger' ? ' ui-alert-danger' : ''}`}>
            <AlertDialog.Title className="ph ui-dialog-title">{title}</AlertDialog.Title>
            <AlertDialog.Description className="ui-dialog-text">{description}</AlertDialog.Description>
            <div className="ui-dialog-foot">
              <AlertDialog.Close className="btn" disabled={busy}>
                Cancel
              </AlertDialog.Close>
              <button
                type="button"
                className={tone === 'danger' ? 'btn btn-danger' : 'btn btn-primary'}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onConfirm();
                  } finally {
                    setBusy(false);
                    setOpen(false);
                  }
                }}
              >
                {busy ? 'Working…' : confirm}
              </button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
