import { cloneElement, createContext, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { DotsIcon } from './ui/icons';
import { Menu, type MenuEntry } from './ui/Menu';

/*
 * The bar under every page's banner (docs/decisions/app-design-direction.md): the page's controls on
 * the left (filters, a period, a way back), its actions on the right (one yellow primary, the rest
 * quiet, the overflow behind a menu). It sticks under the top of the window while the page scrolls
 * and lifts a little once stuck. On a phone it stays one row: the controls and the actions scroll
 * sideways, each action with its glyph and its words.
 */

/**
 * Where a nested route's toolbar goes. Settings' layout owns the banner while each section owns its
 * actions, so the section renders its `PageToolbar` as usual and it lands here, under the banner.
 */
const HostContext = createContext<HTMLElement | null | undefined>(undefined);

export function PageToolbarHost({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  return (
    <HostContext.Provider value={host}>
      <div className="page-toolbar-host" ref={setHost} />
      {children}
    </HostContext.Provider>
  );
}

function Bar({ label, controls, actions }: { label: string; controls?: ReactNode; actions?: ReactNode }) {
  const sentinel = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  // A line just above the bar: once it leaves the top of the window, the bar is stuck
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setStuck(entry !== undefined && !entry.isIntersecting && entry.boundingClientRect.top < 0), { threshold: 0 });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <div ref={sentinel} className="page-toolbar-sentinel" aria-hidden="true" />
      <div className="page-toolbar" role="region" aria-label={label} data-stuck={stuck || undefined}>
        <div className="page-toolbar-controls">{controls}</div>
        {actions && <div className="page-toolbar-actions">{actions}</div>}
      </div>
    </>
  );
}

/** The page's toolbar; inside a `PageToolbarHost` it renders in the host's place instead of its own */
export function PageToolbar(props: { label: string; controls?: ReactNode; actions?: ReactNode }) {
  const host = useContext(HostContext);
  if (host === undefined) return <Bar {...props} />;
  // The host is known only once it is mounted, so the server and the first render draw nothing here
  return host ? createPortal(<Bar {...props} />, host) : null;
}

type ActionProps = {
  /** The action in words, beside the glyph on every screen */
  label: string;
  icon: ReactNode;
  /** The page's one yellow action */
  primary?: boolean;
  /** Words that replace the label while it runs ("Saving…"), so the name stays the action's own */
  busyLabel?: string | false;
  /** A link instead of a button: the element (a router `Link`, an `a`) whose look this sets */
  render?: ReactElement;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>;

/** A toolbar action: a glyph and its words */
export function ToolbarAction({ label, icon, primary, busyLabel, render, className, ...button }: ActionProps) {
  const classes = `btn btn-small tb-action${primary ? ' btn-primary' : ' tb-quiet'}${className ? ` ${className}` : ''}`;
  const text = busyLabel || label;
  const body = (
    <>
      {icon}
      <span className="tb-label">{text}</span>
    </>
  );
  if (render) {
    const element = render as ReactElement<{ className?: string; children?: ReactNode }>;
    return cloneElement(element, { className: classes, children: body });
  }
  return (
    <button type="button" className={classes} {...button}>
      {body}
    </button>
  );
}

/** The actions that do not earn a button of their own, behind one */
export function ToolbarMore({ entries, label = 'More actions' }: { entries: ReadonlyArray<MenuEntry>; label?: string }) {
  return (
    <Menu
      align="end"
      entries={entries}
      trigger={
        <button type="button" className="ui-icon-button tb-more" aria-label={label}>
          <DotsIcon />
        </button>
      }
    />
  );
}
