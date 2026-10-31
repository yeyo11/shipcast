import { Drawer as Base } from '@base-ui/react/drawer';
import type { CSSProperties, ReactElement, ReactNode } from 'react';

export interface SheetProps {
  /** The sheet's accessible name; shown only when `showTitle` (most boards lead with their own heading) */
  label: string;
  children: ReactNode;
  trigger?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** How far above the window's bottom it stops: More sits on the bottom bar (76) */
  bottom?: number;
  style?: CSSProperties;
  className?: string;
}

/**
 * The board's bottom sheet: the raised card with its grab handle over a dark scrim, within reach of
 * the thumb. Swipe down, Escape or a tap on the scrim close it; focus stays inside while it is open
 * and goes back to its trigger after (Base UI's drawer).
 */
export function Sheet({ label, children, trigger, open, onOpenChange, bottom = 0, style, className }: SheetProps) {
  return (
    <Base.Root swipeDirection="down" open={open} onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}>
      {trigger && <Base.Trigger render={trigger} />}
      <Base.Portal>
        <Base.Backdrop className="k-scrim k-sheet-scrim" style={{ bottom }} />
        <Base.Viewport className="k-sheet-viewport" style={{ bottom }}>
          <Base.Popup className={`k-sheet${className ? ` ${className}` : ''}`} style={style} aria-label={label}>
            <div className="k-grab" aria-hidden="true" />
            <Base.Title className="visually-hidden">{label}</Base.Title>
            {children}
          </Base.Popup>
        </Base.Viewport>
      </Base.Portal>
    </Base.Root>
  );
}

/** Closes the sheet it is in: for links inside it, so a navigation also dismisses it */
export const SheetClose = Base.Close;
