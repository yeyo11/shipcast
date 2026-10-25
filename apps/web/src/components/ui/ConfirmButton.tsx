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
  /** More inside the question, such as a field to type the name of what goes */
  body?: ReactNode;
  /** Keeps the confirming button off until the body is filled in */
  confirmDisabled?: boolean;
}

/**
 * A button that asks before it acts: Base UI's AlertDialog in place of `window.confirm`, so the
 * question looks like the app, names the consequence, and focus comes back to the button after.
 * The safe choice (Cancel) has the focus when it opens, so Enter never confirms by accident.
 */
export function ConfirmButton({ children, className = 'btn', disabled, ...question }: ConfirmButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <ConfirmDialog {...question} open={open} onOpenChange={setOpen} trigger={{ className, disabled, children }} />
  );
}

export type ConfirmDialogProps = Omit<ConfirmButtonProps, 'children' | 'className' | 'disabled'> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Its own button; left out when something else opens it, such as a row's menu */
  trigger?: { className: string; disabled: boolean | undefined; children: ReactNode };
};

/** The same question, opened by whatever sets `open`: a menu item cannot hold a dialog's trigger, since the menu closes */
export function ConfirmDialog({ open, onOpenChange, trigger, title, description, confirm, tone = 'danger', onConfirm, body, confirmDisabled }: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      {trigger && (
        <AlertDialog.Trigger className={trigger.className} disabled={trigger.disabled}>
          {trigger.children}
        </AlertDialog.Trigger>
      )}
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="ui-backdrop" />
        <AlertDialog.Viewport className="ui-dialog-viewport">
          <AlertDialog.Popup className={`ui-dialog ui-alert${tone === 'danger' ? ' ui-alert-danger' : ''}`}>
            <AlertDialog.Title className="ph ui-dialog-title">{title}</AlertDialog.Title>
            <AlertDialog.Description className="ui-dialog-text" render={<div />}>
              {description}
            </AlertDialog.Description>
            {body}
            <div className="ui-dialog-foot">
              <AlertDialog.Close className="btn" disabled={busy}>
                Cancel
              </AlertDialog.Close>
              <button
                type="button"
                className={tone === 'danger' ? 'btn btn-danger' : 'btn btn-primary'}
                disabled={busy || confirmDisabled}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onConfirm();
                  } finally {
                    setBusy(false);
                    onOpenChange(false);
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
