import { Popover as Base } from '@base-ui/react/popover';
import type { ReactElement, ReactNode } from 'react';

export interface PopoverProps {
  trigger: ReactElement;
  title?: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}

/**
 * A small card anchored to its trigger, for an explanation or a few controls that do not deserve a
 * dialog. Not modal: the page stays usable; Escape or a click outside closes it.
 */
export function Popover({ trigger, title, children, side = 'bottom' }: PopoverProps) {
  return (
    <Base.Root>
      <Base.Trigger render={trigger} />
      <Base.Portal>
        <Base.Positioner className="ui-positioner" side={side} sideOffset={8}>
          <Base.Popup className="ui-popup ui-popover">
            {title && <Base.Title className="ui-popover-title">{title}</Base.Title>}
            <div className="ui-popover-body">{children}</div>
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
