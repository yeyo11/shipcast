import { useRef, type KeyboardEvent } from 'react';
import { formatTime, parseTime, stepTime, typeTime, type TimeParts, type TimeUnit } from './dates';

export interface TimeFieldProps {
  id: string;
  /** Names the field for a screen reader: the visible label is up to the caller */
  label: string;
  /** `HH:MM` in 24 hours, or empty for no time yet */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** The time an empty field starts from when it is stepped or typed into */
  fallback?: string;
}

/*
 * A time of day in place of the native `<input type="time">`, which ignores Cartel and shows a
 * 12-hour clock to some locales. Two numeric segments, hour and minute, in 24 hours: type the digits,
 * or use Up and Down (they wrap), and Left, Right and `:` move between the two. `inputMode="numeric"`
 * gives a phone its number pad. The value stays the `HH:MM` text the `datetime-local` helpers read.
 */
export function TimeField({ id, label, value, onChange, disabled, fallback = '00:00' }: TimeFieldProps) {
  const hourRef = useRef<HTMLInputElement>(null);
  const minuteRef = useRef<HTMLInputElement>(null);
  const parts = parseTime(value);
  const base: TimeParts = parts ?? parseTime(fallback) ?? { hour: 0, minute: 0 };
  const commit = (next: TimeParts) => onChange(formatTime(next));

  const segment = (unit: TimeUnit, ref: typeof hourRef, name: string) => {
    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        commit(stepTime(base, unit, event.key === 'ArrowUp' ? 1 : -1));
      } else if (event.key === 'ArrowRight' && unit === 'hour') {
        event.preventDefault();
        minuteRef.current?.focus();
      } else if (event.key === 'ArrowLeft' && unit === 'minute') {
        event.preventDefault();
        hourRef.current?.focus();
      } else if (event.key === ':' && unit === 'hour') {
        event.preventDefault();
        minuteRef.current?.focus();
      } else if (event.key === 'Backspace' || event.key === 'Delete') {
        // The segments always show two digits, so an erase that left one would only come back: clear the time instead
        event.preventDefault();
        onChange('');
      }
    };
    return (
      <input
        ref={ref}
        id={unit === 'hour' ? id : undefined}
        className="ui-time-segment"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        role="spinbutton"
        aria-label={`${label}, ${name}`}
        aria-valuemin={0}
        aria-valuemax={unit === 'hour' ? 23 : 59}
        aria-valuenow={parts?.[unit]}
        aria-valuetext={parts ? String(parts[unit]).padStart(2, '0') : 'empty'}
        placeholder="––"
        size={2}
        maxLength={3}
        disabled={disabled}
        value={parts ? String(parts[unit]).padStart(2, '0') : ''}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={onKeyDown}
        onChange={(event) => {
          const next = typeTime(base, unit, event.target.value);
          if (!next) return;
          commit(next);
          // A last digit past 2 cannot be the first of an hour: the minutes are next
          if (unit === 'hour' && Number(event.target.value.replace(/\D/g, '').slice(-1)) > 2) minuteRef.current?.focus();
        }}
      />
    );
  };

  return (
    <div className="ui-time" role="group" aria-label={label} data-disabled={disabled || undefined}>
      {segment('hour', hourRef, 'hour')}
      <span className="ui-time-colon" aria-hidden="true">
        :
      </span>
      {segment('minute', minuteRef, 'minute')}
    </div>
  );
}
