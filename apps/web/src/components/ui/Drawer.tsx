import { Drawer as Base } from '@base-ui/react/drawer';
import type { ReactElement, ReactNode } from 'react';
import { CloseIcon } from './icons';

export interface DrawerProps {
  title: ReactNode;
  children: ReactNode;
  trigger?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * A sheet from the bottom of the screen, within reach of the thumb: the phone's "More". Swiping it
 * down, Escape, the close button or a tap on the backdrop dismiss it; focus is kept inside while it
 * is open and goes back to the trigger after.
 */
export function Drawer({ title, children, trigger, open, onOpenChange }: DrawerProps) {
  return (
    <Base.Root swipeDirection="down" open={open} onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}>
      {trigger && <Base.Trigger render={trigger} />}
      <Base.Portal>
        <Base.Backdrop className="ui-backdrop ui-drawer-backdrop" />
        <Base.Viewport className="ui-drawer-viewport">
          <Base.Popup className="ui-drawer">
            <div className="ui-drawer-handle" aria-hidden="true" />
            <Base.Content className="ui-drawer-content">
              <header className="ui-dialog-head">
                <Base.Title className="ph ui-dialog-title">{title}</Base.Title>
                <Base.Close className="ui-icon-button" aria-label="Close">
                  <CloseIcon />
                </Base.Close>
              </header>
              {children}
            </Base.Content>
          </Base.Popup>
        </Base.Viewport>
      </Base.Portal>
    </Base.Root>
  );
}

/** Closes the drawer it is in: for links inside it, so a navigation also dismisses the sheet */
export const DrawerClose = Base.Close;
