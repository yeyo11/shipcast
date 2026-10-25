import { Combobox as Base } from '@base-ui/react/combobox';
import { useId, useMemo, type ReactNode } from 'react';
import { CaretIcon, CheckIcon, CloseIcon } from './icons';
import type { Option } from './Select';

export interface ComboboxProps<V extends string> {
  label: ReactNode;
  options: ReadonlyArray<Option<V>>;
  value: V | null;
  onValueChange: (value: V | null) => void;
  placeholder?: string;
  /** What the list says when the search matches nothing */
  empty?: string;
  disabled?: boolean;
  help?: ReactNode;
}

/**
 * A list to pick one from with a search on top, for lists long enough to need it (the owner's
 * repos). The input filters by the label and the hint; the value given back is the option's id,
 * so the page keeps plain strings in its state.
 */
export function Combobox<V extends string>({ label, options, value, onValueChange, placeholder = 'Type to search', empty = 'Nothing matches.', disabled, help }: ComboboxProps<V>) {
  const id = useId();
  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const selected = value === null ? null : (byValue.get(value) ?? null);
  return (
    <div className="field">
      <Base.Root
        items={options as Option<V>[]}
        value={selected}
        onValueChange={(next) => onValueChange(next ? next.value : null)}
        isItemEqualToValue={(a, b) => a.value === b.value}
        itemToStringLabel={(o) => o.label}
        filter={(o, query) => `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())}
        autoHighlight
        disabled={disabled}
      >
        <label className="label" htmlFor={id}>
          {label}
        </label>
        <Base.InputGroup className="ui-combo">
          <Base.Input id={id} className="ui-combo-input" placeholder={placeholder} />
          <Base.Clear className="ui-icon-button ui-combo-clear" aria-label="Clear">
            <CloseIcon size={18} />
          </Base.Clear>
          <Base.Trigger className="ui-icon-button" aria-label="Show the list">
            <CaretIcon />
          </Base.Trigger>
        </Base.InputGroup>
        <Base.Portal>
          <Base.Positioner className="ui-positioner" sideOffset={6}>
            <Base.Popup className="ui-popup ui-listbox">
              <Base.Empty className="ui-empty">{empty}</Base.Empty>
              <Base.List>
                {(o: Option<V>) => (
                  <Base.Item key={o.value} value={o} className="ui-option">
                    <Base.ItemIndicator className="ui-option-check">
                      <CheckIcon size={18} />
                    </Base.ItemIndicator>
                    <span className="ui-option-text">
                      <span>{o.label}</span>
                      {o.hint && <span className="ui-option-hint">{o.hint}</span>}
                    </span>
                  </Base.Item>
                )}
              </Base.List>
            </Base.Popup>
          </Base.Positioner>
        </Base.Portal>
      </Base.Root>
      {help && <small>{help}</small>}
    </div>
  );
}
