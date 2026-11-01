import { useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../kit/Icon';
import { Overlay } from '../kit/Overlay';
import { useToast } from '../Toasts';

/**
 * A question before something that cannot be taken back (board RotateSecret): the heading, what
 * happens, the way out and the action, which runs and then closes the sheet.
 */
export function ConfirmSheet({
  open,
  onOpenChange,
  title,
  children,
  keep,
  confirm,
  icon,
  danger = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  /** The way out: "Keep it" */
  keep: string;
  confirm: string;
  icon?: IconName;
  /** A destructive action reads in the failure colour rather than as the primary one */
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Overlay kind="dialog" label={title} open={open} onOpenChange={onOpenChange} heading={<>{title}</>}>
      <p className="st-sheet-text">{children}</p>
      <div className="k-hrow k-g10">
        <button type="button" className="k-btn" onClick={() => onOpenChange(false)}>
          {keep}
        </button>
        <button
          type="button"
          className={`k-btn k-grow ${danger ? 'k-danger' : 'k-pri'}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
              onOpenChange(false);
            } finally {
              setBusy(false);
            }
          }}
        >
          {icon && <Icon name={icon} size={18} />}
          {confirm}
        </button>
      </div>
    </Overlay>
  );
}

/**
 * A secret shown only this once (board TokenCreated): the value in a yellow-ringed box, Copy, what it
 * belongs to and Done. The value lives only in the page's memory and is dropped when the sheet closes.
 */
export function OnceSheet({ value, title, text, note, onDone }: { value: string | null; title: string; text: string; note: ReactNode; onDone: () => void }) {
  const toast = useToast();
  return (
    <Overlay kind="dialog"
      label={title}
      open={value !== null}
      onOpenChange={(open) => {
        if (!open) onDone();
      }}
     heading={<>{title}</>}>
      <p className="k-sm k-muted st-m0">{text}</p>
      <div className="k-input k-mono st-once-value">{value}</div>
      <button
        type="button"
        className="k-btn k-pri k-full"
        onClick={() => {
          if (value) void navigator.clipboard.writeText(value).then(() => toast.done('Copied'));
        }}
      >
        <Icon name="copy" size={18} />
        Copy
      </button>
      <div className="k-xs k-muted">{note}</div>
      <button type="button" className="k-btn k-full" onClick={onDone}>
        Done
      </button>
    </Overlay>
  );
}
