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
