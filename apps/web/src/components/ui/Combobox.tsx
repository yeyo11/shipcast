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
  /** The input's id, for a page that moves the focus to it */
  id?: string;
  /** What is wrong with the choice, shown under it and tied to the input */
  error?: string;
}

/**
 * A list to pick one from with a search on top, for lists long enough to need it (the owner's
 * repos). The input filters by the label and the hint; the value given back is the option's id,
 * so the page keeps plain strings in its state.
 */
export function Combobox<V extends string>({ label, options, value, onValueChange, placeholder = 'Type to search', empty = 'Nothing matches.', disabled, help, id: given, error }: ComboboxProps<V>) {
  const generated = useId();
  const id = given ?? generated;
  const errorId = `${id}-error`;
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
          <Base.Input id={id} className="ui-combo-input" placeholder={placeholder} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} />
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
      {error && (
        <p className="field-error" id={errorId}>
          {error}
        </p>
      )}
      {help && <small>{help}</small>}
    </div>
  );
}

export interface MultiComboboxProps<V extends string> {
  label: ReactNode;
  options: ReadonlyArray<Option<V>>;
  value: readonly V[];
  onValueChange: (value: V[]) => void;
  placeholder?: string;
  empty?: string;
  /** What the chosen items are called to a screen reader, as in "Chosen channels" */
  noun?: string;
}

/**
 * Several to pick from a list with a search: the chosen ones are chips inside the input, removed with
 * their button or with Backspace. For filters (channels, accounts), where none chosen means all.
 */
export function MultiCombobox<V extends string>({ label, options, value, onValueChange, placeholder = 'All', empty = 'Nothing matches.', noun = 'items' }: MultiComboboxProps<V>) {
  const id = useId();
  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const selected = value.map((v) => byValue.get(v)).filter((o): o is Option<V> => o !== undefined);
  return (
    <div className="field">
      <Base.Root
        multiple
        items={options as Option<V>[]}
        value={selected}
        onValueChange={(next: Option<V>[]) => onValueChange(next.map((o) => o.value))}
        isItemEqualToValue={(a: Option<V>, b: Option<V>) => a.value === b.value}
        itemToStringLabel={(o: Option<V>) => o.label}
        filter={(o: Option<V>, query: string) => `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())}
        autoHighlight
      >
        <label className="label" htmlFor={id}>
          {label}
        </label>
        <Base.InputGroup className="ui-combo ui-combo-multi">
          <Base.Chips className="ui-chips" aria-label={selected.length > 0 ? `Chosen ${noun}` : undefined}>
            {selected.map((o) => (
              <Base.Chip key={o.value} className="ui-chip" aria-description="Press Backspace or Delete to remove">
                <span className="clamp">{o.label}</span>
                <Base.ChipRemove className="ui-chip-remove" aria-label={`Remove ${o.label}`}>
                  <CloseIcon size={14} />
                </Base.ChipRemove>
              </Base.Chip>
            ))}
            <Base.Input
              id={id}
              className="ui-combo-input"
              placeholder={selected.length > 0 ? '' : placeholder}
              aria-description={selected.length > 0 ? `${selected.length} chosen. From the start of the input, press Left Arrow to reach them` : undefined}
            />
          </Base.Chips>
          <Base.Trigger className="ui-icon-button" aria-label={`Show the ${noun}`}>
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
    </div>
  );
}
