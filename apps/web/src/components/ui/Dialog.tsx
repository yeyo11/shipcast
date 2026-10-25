import { Dialog as Base } from '@base-ui/react/dialog';
import type { ReactElement, ReactNode } from 'react';
import { CloseIcon } from './icons';

export interface DialogProps {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** The buttons at the bottom; a `Dialog.Close` among them closes it */
  footer?: ReactNode;
  /** The element that opens it, rendered as Base UI's trigger so focus returns to it on close */
  trigger?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** A wider popup, for content that reads better in columns */
  wide?: boolean;
}

/**
 * A modal in Cartel: the card's outline and the small stamp, the title in Phudu. Base UI traps the
 * focus, closes on Escape and on a click outside, and gives the focus back to what opened it.
 */
export function Dialog({ title, description, children, footer, trigger, open, onOpenChange, wide }: DialogProps) {
  return (
    <Base.Root open={open} onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}>
      {trigger && <Base.Trigger render={trigger} />}
      <Base.Portal>
        <Base.Backdrop className="ui-backdrop" />
        <Base.Viewport className="ui-dialog-viewport">
          <Base.Popup className={`ui-dialog${wide ? ' ui-dialog-wide' : ''}`}>
            <header className="ui-dialog-head">
              <Base.Title className="ph ui-dialog-title">{title}</Base.Title>
              <Base.Close className="ui-icon-button" aria-label="Close">
                <CloseIcon />
              </Base.Close>
            </header>
            {description && <Base.Description className="ui-dialog-text">{description}</Base.Description>}
            {children}
            {footer && <div className="ui-dialog-foot">{footer}</div>}
          </Base.Popup>
        </Base.Viewport>
      </Base.Portal>
    </Base.Root>
  );
}

/** A button that closes the dialog it is in, styled as any `.btn` */
export function DialogClose({ className = 'btn', children }: { className?: string; children: ReactNode }) {
  return <Base.Close className={className}>{children}</Base.Close>;
}
