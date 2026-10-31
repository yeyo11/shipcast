/*
 * The launch page's times in words: an instant on the owner's wall clock (their zone, as the
 * scheduler reads it, so the server and the browser render the same text), how long ago something
 * was read, and how long something has been running. Pure, so the tests read them as the page does.
 */

/** An instant's day and time in the owner's zone: `20 Oct, 12:00` */
export function dayTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/** An instant's day in the owner's zone: `20 Oct` */
export function dayOnly(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short' }).format(new Date(iso));
}

/** How long ago, in the words a phone has room for: `just now`, `12 min ago`, `3 h ago`, `2 days ago`, then the day */
export function ago(iso: string, now: Date, timeZone: string): string {
  const ms = now.getTime() - Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return days === 1 ? 'yesterday' : `${days} days ago`;
  return `on ${dayOnly(iso, timeZone)}`;
}

/** A running time: `52 s`, `1 min 52 s`, `1 h 4 min` */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
