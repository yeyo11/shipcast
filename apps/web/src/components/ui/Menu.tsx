import { Menu as Base } from '@base-ui/react/menu';
import type { ReactElement, ReactNode } from 'react';

export type MenuEntry =
  /** `hint`: a second, smaller line; on a disabled item, why it is disabled, so a refusal is read rather than guessed */
  | { kind?: 'item'; label: ReactNode; onSelect: () => void; disabled?: boolean; tone?: 'danger'; hint?: ReactNode }
  | { kind: 'link'; label: ReactNode; href: string }
  | { kind: 'separator' }
  | { kind: 'note'; label: ReactNode };

export interface MenuProps {
  /** The button that opens it; its accessible name says what the menu is about */
  trigger: ReactElement;
  entries: ReadonlyArray<MenuEntry>;
  align?: 'start' | 'center' | 'end';
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
              return (
                <Base.Item key={i} className={`ui-option${entry.tone === 'danger' ? ' ui-option-danger' : ''}${entry.hint ? ' ui-option-with-hint' : ''}`} onClick={entry.onSelect} disabled={entry.disabled}>
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
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
