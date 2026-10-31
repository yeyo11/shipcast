import { Combobox as BaseCombobox } from '@base-ui/react/combobox';
import { Select as BaseSelect } from '@base-ui/react/select';
import { useId, useMemo, type ReactNode } from 'react';
import { Icon } from '../kit/Icon';

/*
 * The board's pickers (Launch a repo's Repository and Release): a Cartel input with a chevron, its
 * list a raised menu card. Base UI does the keyboard, the typeahead and the focus; the look is the
 * kit's (`k-input`, `k-menu`, `k-mi`).
 */

export interface PickerOption<V extends string = string> {
  value: V;
  label: string;
  /** A quieter second line under the label */
  hint?: string;
}

function OptionBody({ option, mono }: { option: PickerOption; mono?: boolean }) {
  return (
    <span className="wr-option-text">
      <span className={mono ? 'k-mono' : undefined}>{option.label}</span>
      {option.hint && <span className="wr-option-hint">{option.hint}</span>}
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
}

/** One to pick from a long list, with a search: typing filters by the label and the hint */
export function PickerCombobox<V extends string>({ label, options, value, onValueChange, placeholder, empty = 'Nothing matches.', disabled, id: given }: PickerComboboxProps<V>) {
  const generated = useId();
  const id = given ?? generated;
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
        <BaseCombobox.InputGroup className="k-input wr-picker">
          <BaseCombobox.Input id={id} className="wr-picker-input" placeholder={placeholder} />
          <BaseCombobox.Trigger className="wr-picker-chevron" aria-label="Show the list">
            <Icon name="chevronDown" size={18} />
          </BaseCombobox.Trigger>
        </BaseCombobox.InputGroup>
        <BaseCombobox.Portal>
          <BaseCombobox.Positioner className="wr-positioner" sideOffset={6}>
            <BaseCombobox.Popup className="k-menu wr-popup">
              <BaseCombobox.Empty className="wr-empty">{empty}</BaseCombobox.Empty>
              <BaseCombobox.List>
                {(o: PickerOption<V>) => (
                  <BaseCombobox.Item key={o.value} value={o} className="k-mi wr-option">
                    <OptionBody option={o} />
                    <BaseCombobox.ItemIndicator className="wr-option-check">
                      <Icon name="check" size={18} />
                    </BaseCombobox.ItemIndicator>
                  </BaseCombobox.Item>
                )}
              </BaseCombobox.List>
            </BaseCombobox.Popup>
          </BaseCombobox.Positioner>
        </BaseCombobox.Portal>
      </BaseCombobox.Root>
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
}

/** One to pick from a short list */
export function PickerSelect<V extends string>({ label, options, value, onValueChange, placeholder = 'Choose…', disabled, mono, render }: PickerSelectProps<V>) {
  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const chosen = value === null ? undefined : byValue.get(value);
  return (
    <div className="k-field">
      <BaseSelect.Root items={options as PickerOption<V>[]} value={value} onValueChange={(next) => next !== null && onValueChange(next)} disabled={disabled}>
        <BaseSelect.Label className="k-lbl">{label}</BaseSelect.Label>
        <BaseSelect.Trigger className="k-input wr-picker wr-picker-button">
          <span className={`k-grow k-ellipsis${chosen ? '' : ' wr-placeholder'}`}>{chosen ? (render ? render(chosen) : chosen.label) : placeholder}</span>
          <BaseSelect.Icon className="wr-picker-chevron">
            <Icon name="chevronDown" size={18} />
          </BaseSelect.Icon>
        </BaseSelect.Trigger>
        <BaseSelect.Portal>
          <BaseSelect.Positioner className="wr-positioner" sideOffset={6} alignItemWithTrigger={false}>
            <BaseSelect.Popup className="k-menu wr-popup">
              <BaseSelect.List>
                {options.map((o) => (
                  <BaseSelect.Item key={o.value} value={o.value} className="k-mi wr-option">
                    <OptionBody option={o} mono={mono} />
                    <BaseSelect.ItemIndicator className="wr-option-check">
                      <Icon name="check" size={18} />
                    </BaseSelect.ItemIndicator>
                  </BaseSelect.Item>
                ))}
              </BaseSelect.List>
            </BaseSelect.Popup>
          </BaseSelect.Positioner>
        </BaseSelect.Portal>
      </BaseSelect.Root>
    </div>
  );
}
