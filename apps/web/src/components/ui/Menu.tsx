import { Menu as Base } from '@base-ui/react/menu';
import type { ReactElement, ReactNode } from 'react';

export type MenuEntry =
  /** `hint`: a second, smaller line; on a disabled item, why it is disabled, so a refusal is read rather than guessed */
  /** `current`: the item goes to the page on screen; it says so (aria-current) and wears the current dot */
  | { kind?: 'item'; label: ReactNode; onSelect: () => void; disabled?: boolean; tone?: 'danger'; hint?: ReactNode; current?: boolean }
  | { kind: 'link'; label: ReactNode; href: string }
  | { kind: 'separator' }
  | { kind: 'note'; label: ReactNode }
  /** An item that opens a nested list: Right arrow opens it, Left closes it (Base UI's own keys) */
  /** `current`: the page on screen is inside it, so the trigger marks the section as the one you are in */
  | { kind: 'submenu'; label: ReactNode; entries: ReadonlyArray<MenuEntry>; current?: boolean };

/** The yellow dot, ringed so it still reads on the day theme's white popup, where yellow alone is 1.4:1 */
function CurrentDot() {
  return <span className="ui-option-dot" aria-hidden="true" />;
}

export interface MenuProps {
  /** The button that opens it; its accessible name says what the menu is about */
  trigger: ReactElement;
  entries: ReadonlyArray<MenuEntry>;
  align?: 'start' | 'center' | 'end';
}

function Entries({ entries }: { entries: ReadonlyArray<MenuEntry> }) {
  return (
    <>
      {entries.map((entry, i) => {
        if (entry.kind === 'separator') return <Base.Separator key={i} className="ui-separator" />;
        if (entry.kind === 'note')
          return (
            <div key={i} className="ui-menu-note">
              {entry.label}
            </div>
          );
        if (entry.kind === 'link')
          return (
            <Base.LinkItem key={i} className="ui-option" href={entry.href}>
              {entry.label}
            </Base.LinkItem>
          );
        if (entry.kind === 'submenu')
          return (
            <Base.SubmenuRoot key={i}>
              <Base.SubmenuTrigger className="ui-option ui-option-submenu" aria-current={entry.current ? 'true' : undefined} data-current={entry.current ? '' : undefined}>
                <span className="ui-option-label">
                  {entry.current && <CurrentDot />}
                  {entry.label}
                </span>
                <span className="ui-option-chevron" aria-hidden="true">
                  ›
                </span>
              </Base.SubmenuTrigger>
              <Base.Portal>
                <Base.Positioner className="ui-positioner" sideOffset={4} alignOffset={-8} collisionPadding={8}>
                  <Base.Popup className="ui-popup ui-menu">
                    <Entries entries={entry.entries} />
                  </Base.Popup>
                </Base.Positioner>
              </Base.Portal>
            </Base.SubmenuRoot>
          );
        return (
          <Base.Item
            key={i}
            className={`ui-option${entry.tone === 'danger' ? ' ui-option-danger' : ''}${entry.hint ? ' ui-option-with-hint' : ''}`}
            onClick={entry.onSelect}
            disabled={entry.disabled}
            aria-current={entry.current ? 'page' : undefined}
            data-current={entry.current ? '' : undefined}
          >
            {entry.current && <CurrentDot />}
            {entry.hint ? (
              <span className="ui-option-text">
                <span>{entry.label}</span>
                <span className="ui-option-hint">{entry.hint}</span>
              </span>
            ) : (
              entry.label
            )}
          </Base.Item>
        );
      })}
    </>
  );
}

/**
 * A short list of actions behind one button, for rows that would otherwise carry five buttons.
 * Arrow keys move, Enter or Space acts, Escape closes and focus returns to the trigger.
 */
export function Menu({ trigger, entries, align = 'end' }: MenuProps) {
  return (
    <Base.Root>
      <Base.Trigger render={trigger} />
      <Base.Portal>
        <Base.Positioner className="ui-positioner" sideOffset={6} align={align}>
          <Base.Popup className="ui-popup ui-menu">
            <Entries entries={entries} />
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
