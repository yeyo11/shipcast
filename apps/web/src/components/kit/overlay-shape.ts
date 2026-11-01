/**
 * What an overlay is (kit/Overlay.tsx), which decides its shape on a desktop:
 * - `menu`: a short list of actions, anchored to the button that opened it
 * - `drawer`: a form or details, in a panel from the right edge with its own title and close
 * - `dialog`: a confirmation, centred
 * - `popover`: something to read, anchored to what it is about
 */
export type OverlayKind = 'menu' | 'drawer' | 'dialog' | 'popover';

/** How an overlay is drawn: every kind is the bottom sheet on a phone, its own shape from 960 px */
export type OverlayShape = 'sheet' | OverlayKind;

export function overlayShape(kind: OverlayKind, phone: boolean): OverlayShape {
  return phone ? 'sheet' : kind;
}

/** The keys that move through a menu's items, and where each one goes from `at` among `count` */
export function menuStep(key: string, at: number, count: number): number | null {
  if (count === 0) return null;
  if (key === 'ArrowDown') return at < 0 ? 0 : (at + 1) % count;
  if (key === 'ArrowUp') return at < 0 ? count - 1 : (at - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}
