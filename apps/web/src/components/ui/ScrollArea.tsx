import { ScrollArea as Base } from '@base-ui/react/scroll-area';
import type { CSSProperties, ReactNode } from 'react';

export interface ScrollAreaProps {
  children: ReactNode;
  /** The region's height ceiling (any CSS length): it grows with its content up to this, then scrolls */
  maxHeight?: string;
  /** Which way it scrolls; vertical by default */
  orientation?: 'vertical' | 'horizontal' | 'both';
  /** Names the region for assistive technology; with it the viewport is a landmark the keyboard can scroll */
  label?: string;
  className?: string;
}

/**
 * A scrolling region with Cartel's scrollbar: a thin rail and a thumb in the role colours, shown
 * while the pointer is over the region or it scrolls, and always on a touch screen, which has no
 * hover. Native scrolling underneath, so wheel, touch, keyboard and find-in-page work as ever.
 * The page's own scrollbar is styled in CSS (`html`), not through this.
 */
export function ScrollArea({ children, maxHeight, orientation = 'vertical', label, className }: ScrollAreaProps) {
  const style = maxHeight ? ({ '--ui-scroll-max': maxHeight } as CSSProperties) : undefined;
  return (
    <Base.Root className={`ui-scroll${className ? ` ${className}` : ''}`} style={style}>
      <Base.Viewport className="ui-scroll-viewport" {...(label ? { role: 'region', 'aria-label': label, tabIndex: 0 } : {})}>
        <Base.Content>{children}</Base.Content>
      </Base.Viewport>
      {orientation !== 'horizontal' && (
        <Base.Scrollbar orientation="vertical" className="ui-scrollbar">
          <Base.Thumb className="ui-scroll-thumb" />
        </Base.Scrollbar>
      )}
      {orientation !== 'vertical' && (
        <Base.Scrollbar orientation="horizontal" className="ui-scrollbar">
          <Base.Thumb className="ui-scroll-thumb" />
        </Base.Scrollbar>
      )}
    </Base.Root>
  );
}
