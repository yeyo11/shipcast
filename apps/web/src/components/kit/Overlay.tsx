import { Dialog } from '@base-ui/react/dialog';
import { Drawer } from '@base-ui/react/drawer';
import { mergeProps } from '@base-ui/react/merge-props';
import { Popover } from '@base-ui/react/popover';
import { useRender } from '@base-ui/react/use-render';
import { createContext, useCallback, useContext, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { Icon } from './Icon';
import { menuStep, overlayShape, type OverlayKind } from './overlay-shape';
import { usePhone } from './usePhone';

export type { OverlayKind } from './overlay-shape';

/*
 * Every overlay of the app in one component. On a phone (below 960 px) each is the board's bottom
 * sheet, within reach of the thumb. From 960 px its `kind` decides: a menu anchored to its button,
 * a drawer from the right edge, a centred dialog or an anchored popover (docs/plans/redesign.md,
 * "Overlays on a desktop"). The content is the same in every shape; only the container changes.
 */

export interface OverlayProps {
  kind: OverlayKind;
  /** The overlay's accessible name; the drawer's visible title when there is no `heading` */
  label: string;
  /**
   * The overlay's visible title: the sheet's and the dialog's big heading, the drawer's header, a
   * smaller line on top of a menu or a popover
   */
  heading?: ReactNode;
  children: ReactNode;
  trigger?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * A menu or popover opened from code rather than by `trigger`: the element it hangs from on a
   * desktop, and where the focus goes back to when it closes
   */
  anchor?: Element | null;
  align?: 'start' | 'center' | 'end';
  /** The sheet only: how far above the window's bottom it stops (More sits on the bottom bar, 76) */
  bottom?: number;
  /**
   * The overlay's closing actions: after the content in a sheet, at the drawer's foot on a desktop
   * (board DesktopDrawer), fixed there while the content above scrolls
   */
  footer?: ReactNode;
  /** A wide drawer (720 px, never closer than 240 px to the window's left edge), for large content: a post to edit, a prompt, logs */
  wide?: boolean;
  style?: CSSProperties;
  className?: string;
}

const Close = createContext<(() => void) | null>(null);

/** Closes the overlay it is in, whatever its shape: for links and actions inside it */
export function OverlayClose({ render, ...props }: useRender.ComponentProps<'button'> & { nativeButton?: boolean }) {
  const close = useContext(Close);
  const { nativeButton: _native, ...rest } = props;
  return useRender({
    render: render ?? <button type="button" />,
    props: mergeProps<'button'>(rest, { onClick: () => close?.() }),
  });
}

const cls = (...names: Array<string | false | undefined>) => names.filter(Boolean).join(' ');

/** The items a menu's arrow keys move through */
const ITEMS = '.k-mi:not(:disabled), [role="menuitem"]:not([aria-disabled="true"])';

export function Overlay({ kind, label, heading, footer, children, trigger, open, onOpenChange, anchor, align = 'end', bottom = 0, wide, style, className }: OverlayProps) {
  const phone = usePhone();
  const shape = overlayShape(kind, phone);
  const [own, setOwn] = useState(false);
  const isOpen = open ?? own;
  const setOpen = useCallback(
    (next: boolean) => {
      if (open === undefined) setOwn(next);
      onOpenChange?.(next);
    },
    [open, onOpenChange],
  );
  const close = useCallback(() => setOpen(false), [setOpen]);
  const popup = useRef<HTMLDivElement>(null);
  // Opened from code with no anchor given: hang from what had the focus when it opened (the button
  // that was pressed), and give the focus back to it
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (isOpen && !wasOpen.current && typeof document !== 'undefined') {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  wasOpen.current = isOpen;
  const from = anchor ?? (trigger ? null : opener.current);
  // Never on the server, which has no DOM: overlays render closed there
  const back = typeof HTMLElement !== 'undefined' && from instanceof HTMLElement ? from : undefined;

  if (shape === 'sheet') {
    return (
      <Close.Provider value={close}>
        <Drawer.Root swipeDirection="down" open={isOpen} onOpenChange={(next) => setOpen(next)}>
          {trigger && <Drawer.Trigger render={trigger} />}
          <Drawer.Portal>
            <Drawer.Backdrop className="k-scrim k-sheet-scrim" style={{ bottom }} />
            <Drawer.Viewport className="k-sheet-viewport" style={{ bottom }}>
              <Drawer.Popup className={cls('k-sheet', className)} style={style} aria-label={label}>
                <div className="k-grab" aria-hidden="true" />
                <Drawer.Title className="visually-hidden">{label}</Drawer.Title>
                {heading && <h2 className="k-d k-d30">{heading}</h2>}
                {children}
                {footer}
              </Drawer.Popup>
            </Drawer.Viewport>
          </Drawer.Portal>
        </Drawer.Root>
      </Close.Provider>
    );
  }

  if (shape === 'menu' || shape === 'popover') {
    const menu = shape === 'menu';
    // A menu's arrows, Home and End move between its items, as a platform menu's do (from the popup
    // itself, the first or the last); opened from the keyboard it starts on its first item; Tab still leaves
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (!menu || !popup.current) return;
      const items = [...popup.current.querySelectorAll<HTMLElement>(ITEMS)];
      const next = menuStep(event.key, items.indexOf(document.activeElement as HTMLElement), items.length);
      if (next === null) return;
      event.preventDefault();
      items[next]?.focus();
    };
    return (
      <Close.Provider value={close}>
        <Popover.Root
          open={isOpen}
          onOpenChange={(next, details) => {
            // A press on the anchor is its own toggle: the outside press must not close it first
            if (!next && back && details.reason === 'outside-press' && details.event.target instanceof Node && back.contains(details.event.target)) return;
            setOpen(next);
          }}
        >
          {trigger && <Popover.Trigger render={trigger} />}
          <Popover.Portal>
            <Popover.Positioner className="k-ov-positioner" side="bottom" align={align} sideOffset={8} collisionPadding={12} {...(!trigger && from ? { anchor: from } : {})}>
              <Popover.Popup
                ref={popup}
                className={cls('k-menu', menu ? 'k-ov-menu' : 'k-ov-pop', className)}
                style={style}
                aria-label={label}
                onKeyDown={onKeyDown}
                initialFocus={(openType) => (menu && openType === 'keyboard' ? (popup.current?.querySelector<HTMLElement>(ITEMS) ?? true) : true)}
                {...(back ? { finalFocus: () => back } : {})}
              >
                <Popover.Title className="visually-hidden">{label}</Popover.Title>
                {heading && !menu && (
                  <h2 className="k-d k-ov-title" aria-hidden="true">
                    {heading}
                  </h2>
                )}
                {children}
                {footer}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      </Close.Provider>
    );
  }

  const drawer = shape === 'drawer';
  return (
    <Close.Provider value={close}>
      <Dialog.Root open={isOpen} onOpenChange={(next) => setOpen(next)}>
        {trigger && <Dialog.Trigger render={trigger} />}
        <Dialog.Portal>
          <Dialog.Backdrop className="k-scrim k-ov-scrim" />
          {drawer ? (
            <Dialog.Popup className={cls('k-ov-drawer', wide && 'k-ov-wide', className)} style={style} {...(back ? { finalFocus: () => back } : {})}>
              <header className="k-hrow k-between k-g12 k-ov-head">
                <Dialog.Title className="k-d k-d30">{heading ?? label}</Dialog.Title>
                <Dialog.Close className="k-btn k-icon" aria-label="Close">
                  <Icon name="close" size={20} />
                </Dialog.Close>
              </header>
              <div className="k-ov-body">{children}</div>
              {footer && <div className="k-ov-foot">{footer}</div>}
            </Dialog.Popup>
          ) : (
            <Dialog.Viewport className="k-ov-viewport">
              <Dialog.Popup className={cls('k-ov-dialog', className)} style={style} {...(back ? { finalFocus: () => back } : {})}>
                {heading ? <Dialog.Title className="k-d k-d30">{heading}</Dialog.Title> : <Dialog.Title className="visually-hidden">{label}</Dialog.Title>}
                {children}
                {footer}
              </Dialog.Popup>
            </Dialog.Viewport>
          )}
        </Dialog.Portal>
      </Dialog.Root>
    </Close.Provider>
  );
}
