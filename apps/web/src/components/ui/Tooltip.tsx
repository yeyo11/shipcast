import { Tooltip as Base } from '@base-ui/react/tooltip';
import type { ReactElement, ReactNode } from 'react';

/** One provider for the whole app, so moving between triggers shows the next tooltip at once */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <Base.Provider delay={400} closeDelay={80}>
      {children}
    </Base.Provider>
  );
}

/**
 * A short label on hover or keyboard focus: the full text of something clamped, or a shortcut. Never
 * the only place information lives, since touch screens do not hover: whatever it says is also in
 * the element's accessible name or on the page.
 */
export function Tooltip({ content, children, side = 'top' }: { content: ReactNode; children: ReactElement; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <Base.Root>
      <Base.Trigger render={children} />
      <Base.Portal>
        <Base.Positioner className="ui-positioner" side={side} sideOffset={8}>
          <Base.Popup className="ui-tooltip">{content}</Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
