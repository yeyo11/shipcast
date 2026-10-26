/*
 * Days as the app keeps them (`YYYY-MM-DD`, a wall-clock day with no zone) and as the calendar wants
 * them (a local `Date` at midnight). Built from the parts, never parsed as an instant, so a day never
 * slides into the one before for someone west of UTC, and the server and the browser format it alike.
 */

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The app's dates read day first, in 24 hours, like the rest of its labels (`Thu 1 Oct 2026`) */
export const DATE_LOCALE = 'en-GB';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** A `YYYY-MM-DD` day as a local midnight, or undefined for anything that is not a real day */
export function dayToDate(day: string | undefined): Date | undefined {
  const m = day ? DAY.exec(day) : null;
  if (!m) return undefined;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // 2026-02-31 would roll into March: refuse it rather than show another day
  return dateToDay(date) === day ? date : undefined;
}

/** A local date's day, `YYYY-MM-DD` */
export function dateToDay(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** A day for reading: `Thu 1 Oct 2026` (`1 Oct 2026` when short) */
export function formatDay(day: string, short = false): string {
  const date = dayToDate(day);
  if (!date) return day;
  return new Intl.DateTimeFormat(DATE_LOCALE, short ? { day: 'numeric', month: 'short', year: 'numeric' } : { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

/** A range for reading, with the year once when both ends share it: `1 Oct – 31 Oct 2026` */
export function formatRange(from: string | undefined, to: string | undefined): string {
  const start = dayToDate(from);
  const end = dayToDate(to);
  if (!start || !from) return '';
  if (!end || !to) return `From ${formatDay(from, true)}`;
  if (from === to) return formatDay(from, true);
  const sameYear = start.getFullYear() === end.getFullYear();
  const head = new Intl.DateTimeFormat(DATE_LOCALE, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }).format(start);
  return `${head} – ${formatDay(to, true)}`;
}

/*
 * Times as the `datetime-local` text keeps them (`HH:MM`, 24 hours, no zone) and as the time field edits
 * them: an hour and a minute, each a number that wraps around and takes typed digits.
 */

export interface TimeParts {
  hour: number;
  minute: number;
}

export type TimeUnit = 'hour' | 'minute';

const TIME = /^(\d{2}):(\d{2})$/;

/** `HH:MM` as its parts, or undefined for anything that is not a real time of day */
export function parseTime(value: string | undefined): TimeParts | undefined {
  const m = value ? TIME.exec(value) : null;
  if (!m) return undefined;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : undefined;
}

export function formatTime({ hour, minute }: TimeParts): string {
  return `${pad2(hour)}:${pad2(minute)}`;
}

const MAX: Record<TimeUnit, number> = { hour: 23, minute: 59 };

/** One arrow press: the unit goes up or down and wraps (23 to 00, 00 to 59) without carrying into the other */
export function stepTime(parts: TimeParts, unit: TimeUnit, delta: number): TimeParts {
  const size = MAX[unit] + 1;
  return { ...parts, [unit]: (((parts[unit] + delta) % size) + size) % size };
}

/**
 * Digits typed into a unit that shows two: the new digit joins the last one shown, like a clock's
 * segments (a shown `01` then a typed 7 is 17), and what is past the unit's limit stops at it.
 * Anything that is not a digit is ignored; undefined when nothing usable was typed.
 */
export function typeTime(parts: TimeParts, unit: TimeUnit, typed: string): TimeParts | undefined {
  const digits = typed.replace(/\D/g, '');
  if (!digits) return undefined;
  return { ...parts, [unit]: Math.min(Number(digits.slice(-2)), MAX[unit]) };
}
