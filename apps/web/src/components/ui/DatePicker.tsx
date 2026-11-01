import { useState, type ReactElement, type ReactNode } from 'react';
import { DayPicker, type ChevronProps, type DateRange, type Matcher } from 'react-day-picker';
import { enGB } from 'react-day-picker/locale';
import { Icon } from '../kit/Icon';
import { Overlay } from '../kit/Overlay';
import { usePhone } from '../kit/usePhone';
import { ChevronIcon } from './icons';
import { dateToDay, dayToDate, formatDay, formatRange } from './dates';

/*
 * Day pickers in place of the native `<input type="date">`, whose popups ignore Cartel and overflow
 * a phone. The calendar is react-day-picker (its grid, arrows, Page Up/Down for months, Home/End for
 * the week), with none of its own theme: every part is styled in components.css with the role
 * tokens, and the kit's yellow day inside the kit's overlay (kit.css, `.k-cal`). The trigger is the
 * kit's input; the calendar opens in the kit's popover on a desktop and its bottom sheet on a phone.
 * Weeks start on Monday and days read day first (en-GB), as everywhere else in the app.
 */

function Chevron({ orientation, size }: ChevronProps) {
  return <ChevronIcon dir={orientation === 'left' ? 'left' : 'right'} size={size ? Math.min(size, 20) : 20} />;
}

/** The calendar's settings every picker shares */
const CALENDAR = {
  locale: enGB,
  weekStartsOn: 1,
  showOutsideDays: true,
  autoFocus: true,
  components: { Chevron },
} as const;

function limits(min: string | undefined, max: string | undefined): { disabled: Matcher[]; startMonth?: Date; endMonth?: Date } {
  const start = dayToDate(min);
  const end = dayToDate(max);
  const disabled: Matcher[] = [];
  if (start) disabled.push({ before: start });
  if (end) disabled.push({ after: end });
  return { disabled, startMonth: start, endMonth: end };
}

/** The kit's popover on a desktop, its bottom sheet on a phone: the same calendar in both */
function Shell({ label, trigger, open, onOpenChange, children }: { label: string; trigger: ReactElement; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  return (
    <Overlay kind="popover" label={label} align="start" trigger={trigger} open={open} onOpenChange={onOpenChange} className="k-cal">
      <div className="ui-date-sheet">{children}</div>
    </Overlay>
  );
}

function Trigger({ id, label, text, placeholder, disabled, ...rest }: { id?: string; label: string; text: string; placeholder: string; disabled?: boolean }) {
  // Base UI's trigger passes its own props (aria-expanded, onClick, the ref) through `rest`
  return (
    <button {...rest} type="button" id={id} className={`k-input k-date-trigger${text ? '' : ' k-ph'}`} disabled={disabled} aria-label={`${label}: ${text || placeholder}`}>
      <span className="k-grow k-ellipsis">{text || placeholder}</span>
      <span className="k-muted k-hrow" aria-hidden="true">
        <Icon name="calendar" size={18} />
      </span>
    </button>
  );
}

export interface DatePickerProps {
  /** The control's accessible name, and the sheet's title on a phone */
  label: string;
  /** A day, `YYYY-MM-DD`, or '' while none is chosen */
  value: string;
  onChange: (day: string) => void;
  /** The first and last days that can be picked, `YYYY-MM-DD` */
  min?: string;
  max?: string;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  /** The day without its weekday: `1 Oct 2026` */
  short?: boolean;
}

/** One day: the trigger reads it in words, picking a day closes the calendar */
export function DatePicker({ label, value, onChange, min, max, id, placeholder = 'Pick a day', disabled, short }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const selected = dayToDate(value);
  const bounds = limits(min, max);
  return (
    <Shell label={label} open={open} onOpenChange={setOpen} trigger={<Trigger id={id} label={label} text={value ? formatDay(value, short) : ''} placeholder={placeholder} disabled={disabled} />}>
      <DayPicker
        {...CALENDAR}
        {...bounds}
        mode="single"
        selected={selected}
        defaultMonth={selected ?? bounds.endMonth}
        onSelect={(date) => {
          if (!date) return;
          onChange(dateToDay(date));
          setOpen(false);
        }}
      />
    </Shell>
  );
}

export interface DateRangePickerProps {
  label: string;
  from: string;
  to: string;
  /** Called on every click: `to` is '' while only the start is chosen */
  onChange: (range: { from: string; to: string }) => void;
  min?: string;
  max?: string;
  id?: string;
  placeholder?: string;
}

/**
 * A range of days in one calendar (two months side by side on a desktop): the first click starts
 * it, the second ends it, a third starts again. It stays open until Done, so a range can be read
 * before it is used.
 */
export function DateRangePicker({ label, from, to, onChange, min, max, id, placeholder = 'Pick the days' }: DateRangePickerProps) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const selected: DateRange | undefined = dayToDate(from) ? { from: dayToDate(from), to: dayToDate(to) } : undefined;
  const bounds = limits(min, max);
  const lastShown = selected?.to ?? selected?.from ?? bounds.endMonth;
  // Two months end on the range's last day, so both ends of a recent range are in view
  const firstShown = !phone && lastShown ? new Date(lastShown.getFullYear(), lastShown.getMonth() - 1, 1) : lastShown;
  const summary = formatRange(from, to);
  return (
    <Shell label={label} open={open} onOpenChange={setOpen} trigger={<Trigger id={id} label={label} text={summary} placeholder={placeholder} />}>
      <DayPicker
        {...CALENDAR}
        {...bounds}
        mode="range"
        resetOnSelect
        numberOfMonths={phone ? 1 : 2}
        selected={selected}
        defaultMonth={firstShown}
        onSelect={(range) => onChange({ from: range?.from ? dateToDay(range.from) : '', to: range?.to ? dateToDay(range.to) : '' })}
      />
      <div className="ui-date-foot">
        <span className="muted" aria-live="polite">
          {summary || 'Pick the first day'}
          {summary && !to ? ', then the last' : ''}
        </span>
        <button type="button" className="k-btn k-sm" onClick={() => setOpen(false)}>
          Done
        </button>
      </div>
    </Shell>
  );
}
