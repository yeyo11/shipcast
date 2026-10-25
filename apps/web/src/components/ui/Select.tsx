import { Select as Base } from '@base-ui/react/select';
import type { ReactNode } from 'react';
import { CaretIcon, CheckIcon } from './icons';

export interface Option<V extends string = string> {
  value: V;
  label: string;
  /** A second, quieter line under the label */
  hint?: string;
}

export interface SelectProps<V extends string> {
  label: ReactNode;
  options: ReadonlyArray<Option<V>>;
  value: V | null;
  onValueChange: (value: V) => void;
  placeholder?: string;
  disabled?: boolean;
  /** For values a machine reads (tags, versions): the mono face */
  mono?: boolean;
  /** The field's help line, under the control */
  help?: ReactNode;
}

/**
 * A short list to pick one from, in place of a native `<select>`: the trigger is a Cartel input,
 * the list a raised card; arrow keys, typeahead and Escape come from Base UI. For long lists that
 * need a search, use Combobox.
 */
export function Select<V extends string>({ label, options, value, onValueChange, placeholder = 'Choose…', disabled, mono, help }: SelectProps<V>) {
  return (
    <div className="field">
      <Base.Root items={options as Option<V>[]} value={value} onValueChange={(next) => next !== null && onValueChange(next)} disabled={disabled}>
        <Base.Label className="label">{label}</Base.Label>
        <Base.Trigger className={`ui-trigger${mono ? ' mono' : ''}`}>
          <Base.Value className="ui-trigger-value" placeholder={placeholder} />
          <Base.Icon className="ui-trigger-icon">
            <CaretIcon />
          </Base.Icon>
        </Base.Trigger>
        <Base.Portal>
          <Base.Positioner className="ui-positioner" sideOffset={6} alignItemWithTrigger={false}>
            <Base.Popup className="ui-popup ui-listbox">
              <Base.List>
                {options.map((o) => (
                  <Base.Item key={o.value} value={o.value} className="ui-option">
                    <Base.ItemIndicator className="ui-option-check">
                      <CheckIcon size={18} />
                    </Base.ItemIndicator>
                    <span className="ui-option-text">
                      <Base.ItemText className={mono ? 'mono' : undefined}>{o.label}</Base.ItemText>
                      {o.hint && <span className="ui-option-hint">{o.hint}</span>}
                    </span>
                  </Base.Item>
                ))}
              </Base.List>
            </Base.Popup>
          </Base.Positioner>
        </Base.Portal>
      </Base.Root>
      {help && <small>{help}</small>}
    </div>
  );
}
