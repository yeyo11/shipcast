import { Combobox as BaseCombobox } from '@base-ui/react/combobox';
import { Select as BaseSelect } from '@base-ui/react/select';
import { useId, useMemo, type ReactNode } from 'react';
import { Icon } from '../kit/Icon';

/*
 * The kit's pickers, in place of every native `<select>` (whose list ignores the theme): a Cartel
 * input (or a chip, for a desktop's filters) with a chevron, its list a raised menu card. Base UI
 * does the keyboard, the typeahead and the focus; the look is the kit's (`k-input`, `k-chip`,
 * `k-menu`, `k-mi`).
 */

export interface PickerOption<V extends string = string> {
  value: V;
  label: string;
  /** A quieter second line under the label */
  hint?: string;
}

function OptionBody({ option, mono }: { option: PickerOption; mono?: boolean }) {
  return (
    <span className="k-option-text">
      <span className={mono ? 'k-mono' : undefined}>{option.label}</span>
      {option.hint && <span className="k-option-hint">{option.hint}</span>}
    </span>
  );
}

export interface PickerComboboxProps<V extends string> {
  label: ReactNode;
  options: ReadonlyArray<PickerOption<V>>;
  value: V | null;
  onValueChange: (value: V | null) => void;
  placeholder?: string;
  /** What the list says when the search matches nothing */
  empty?: string;
  disabled?: boolean;
  id?: string;
  /** The field's help line, under it */
  help?: ReactNode;
  /** What is wrong with the choice, under it and tied to the input */
  error?: string;
}

/** One to pick from a long list, with a search: typing filters by the label and the hint */
export function PickerCombobox<V extends string>({ label, options, value, onValueChange, placeholder, empty = 'Nothing matches.', disabled, id: given, help, error }: PickerComboboxProps<V>) {
  const generated = useId();
  const id = given ?? generated;
  const errorId = `${id}-error`;
  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const selected = value === null ? null : (byValue.get(value) ?? null);
  return (
    <div className="k-field">
      <BaseCombobox.Root
        items={options as PickerOption<V>[]}
        value={selected}
        onValueChange={(next) => onValueChange(next ? next.value : null)}
        isItemEqualToValue={(a, b) => a.value === b.value}
        itemToStringLabel={(o) => o.label}
        filter={(o, query) => `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())}
        autoHighlight
        disabled={disabled}
      >
        <label className="k-lbl" htmlFor={id}>
          {label}
        </label>
        <BaseCombobox.InputGroup className="k-input k-picker">
          <BaseCombobox.Input id={id} className="k-picker-input" placeholder={placeholder} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} />
          <BaseCombobox.Trigger className="k-picker-chevron" aria-label="Show the list">
            <Icon name="chevronDown" size={18} />
          </BaseCombobox.Trigger>
        </BaseCombobox.InputGroup>
        <BaseCombobox.Portal>
          <BaseCombobox.Positioner className="k-pop-positioner" sideOffset={6}>
            <BaseCombobox.Popup className="k-menu k-pop-list">
              <BaseCombobox.Empty className="k-pop-empty">{empty}</BaseCombobox.Empty>
              <BaseCombobox.List>
                {(o: PickerOption<V>) => (
                  <BaseCombobox.Item key={o.value} value={o} className="k-mi k-option">
                    <OptionBody option={o} />
                    <BaseCombobox.ItemIndicator className="k-option-check">
                      <Icon name="check" size={18} />
                    </BaseCombobox.ItemIndicator>
                  </BaseCombobox.Item>
                )}
              </BaseCombobox.List>
            </BaseCombobox.Popup>
          </BaseCombobox.Positioner>
        </BaseCombobox.Portal>
      </BaseCombobox.Root>
      {error && (
        <p className="k-field-error" id={errorId}>
          {error}
        </p>
      )}
      {help && <span className="k-help">{help}</span>}
    </div>
  );
}

export interface PickerSelectProps<V extends string> {
  label: ReactNode;
  options: ReadonlyArray<PickerOption<V>>;
  value: V | null;
  onValueChange: (value: V) => void;
  placeholder?: string;
  disabled?: boolean;
  /** For values a machine reads (tags): the mono face in the list */
  mono?: boolean;
  /** How the chosen value shows in the field; its label by default */
  render?: (option: PickerOption<V>) => ReactNode;
  /** `chip`: the desktop filters' chip, its label read only by a screen reader */
  variant?: 'input' | 'chip';
  /** The label for a screen reader only, where the field's place says what it is */
  hideLabel?: boolean;
  /** The field's help line, under it */
  help?: ReactNode;
  className?: string;
  /** The trigger's id, for a link that moves the focus to it */
  id?: string;
}

/** One to pick from a short list */
export function PickerSelect<V extends string>({ label, options, value, onValueChange, placeholder = 'Choose…', disabled, mono, render, variant = 'input', hideLabel, help, className, id }: PickerSelectProps<V>) {
  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const chosen = value === null ? undefined : byValue.get(value);
  const chip = variant === 'chip';
  return (
    <div className={`${chip ? 'k-picker-chip-field' : 'k-field'}${className ? ` ${className}` : ''}`}>
      <BaseSelect.Root items={options as PickerOption<V>[]} value={value} onValueChange={(next) => next !== null && onValueChange(next)} disabled={disabled}>
        <BaseSelect.Label className={chip || hideLabel ? 'visually-hidden' : 'k-lbl'}>{label}</BaseSelect.Label>
        <BaseSelect.Trigger id={id} className={chip ? 'k-chip k-picker-chip' : 'k-input k-picker k-picker-button'}>
          <span className={`${chip ? '' : 'k-grow '}k-ellipsis${chosen ? '' : ' k-placeholder'}`}>{chosen ? (render ? render(chosen) : chosen.label) : placeholder}</span>
          <BaseSelect.Icon className="k-picker-chevron">
            <Icon name="chevronDown" size={chip ? 16 : 18} />
          </BaseSelect.Icon>
        </BaseSelect.Trigger>
        <BaseSelect.Portal>
          <BaseSelect.Positioner className="k-pop-positioner" sideOffset={6} alignItemWithTrigger={false}>
            <BaseSelect.Popup className="k-menu k-pop-list">
              <BaseSelect.List>
                {options.map((o) => (
                  <BaseSelect.Item key={o.value} value={o.value} className="k-mi k-option">
                    <OptionBody option={o} mono={mono} />
                    <BaseSelect.ItemIndicator className="k-option-check">
                      <Icon name="check" size={18} />
                    </BaseSelect.ItemIndicator>
                  </BaseSelect.Item>
                ))}
              </BaseSelect.List>
            </BaseSelect.Popup>
          </BaseSelect.Positioner>
        </BaseSelect.Portal>
      </BaseSelect.Root>
      {help && <span className="k-help">{help}</span>}
    </div>
  );
}
