import { Popover as Base } from '@base-ui/react/popover';
import type { ReactElement, ReactNode } from 'react';

export interface PopoverProps {
  trigger: ReactElement;
  title?: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** Which edge of the trigger the card lines up with first; Base UI flips and shifts it at the screen's edges */
  align?: 'start' | 'center' | 'end';
  /** How far from the viewport's edges the card keeps when it is moved to stay on screen */
  collisionPadding?: number;
  /** Names the card for assistive technology when it has no visible title */
  label?: string;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * A small card anchored to its trigger, for an explanation or a few controls that do not deserve a
 * dialog. Not modal: the page stays usable; Escape or a click outside closes it and the focus goes
 * back to the trigger. In a portal, so a card or a scrolling box never clips it.
 */
export function Popover({ trigger, title, children, side = 'bottom', align = 'center', collisionPadding = 12, label, className, open, onOpenChange }: PopoverProps) {
  return (
    <Base.Root open={open} onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}>
      <Base.Trigger render={trigger} />
      <Base.Portal>
        <Base.Positioner className="ui-positioner" side={side} align={align} sideOffset={8} collisionPadding={collisionPadding}>
          <Base.Popup className={`ui-popup ui-popover${className ? ` ${className}` : ''}`} aria-label={title ? undefined : label}>
            {title && <Base.Title className="ui-popover-title">{title}</Base.Title>}
            <div className="ui-popover-body">{children}</div>
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
