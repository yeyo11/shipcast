import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Drawer } from './Drawer';
import { Popover } from './Popover';

/** Phones, by size or by a finger for a pointer: where a small anchored card is hard to hit and to read */
const PHONE = '(max-width: 640px), (pointer: coarse)';

export function usePhone(): boolean {
  // The server renders the desktop's popover; the first effect on a phone swaps it before anyone taps
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(PHONE);
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return phone;
}

export interface ResponsiveMenuProps {
  trigger: ReactElement;
  /** The sheet's title on a phone, and the popover's accessible name on a desktop */
  label: string;
  children: ReactNode;
  /** Shown only in the sheet, above the content: what a desktop shows elsewhere on hover or beside the menu */
  sheetLead?: ReactNode;
  align?: 'start' | 'center' | 'end';
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * One menu, two shapes: a popover anchored to its trigger on a desktop (Base UI flips and shifts it
 * to stay on screen), a bottom sheet on a phone (swipe it down to close). Same content, same open
 * state, Escape and the focus going back to the trigger in both. Nothing in it depends on hover.
 */
export function ResponsiveMenu({ trigger, label, children, sheetLead, align = 'start', className, open, onOpenChange }: ResponsiveMenuProps) {
  const phone = usePhone();
  if (phone) {
    return (
      <Drawer title={label} trigger={trigger} open={open} onOpenChange={onOpenChange}>
        <div className={`ui-sheet-menu${className ? ` ${className}` : ''}`}>
          {sheetLead}
          {children}
        </div>
      </Drawer>
    );
  }
  return (
    <Popover trigger={trigger} label={label} align={align} className={className} open={open} onOpenChange={onOpenChange}>
      {children}
    </Popover>
  );
}
