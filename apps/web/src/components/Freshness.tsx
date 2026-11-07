import { ageWords, overdueWords, updatedWords, type LaunchUpdated, type TotalAge } from '../server/launch-summary';
import { Tooltip } from './ui/Tooltip';
import { number } from './ui';

/*
 * How fresh a launch's numbers are, kept quiet (docs/web-app.md): one "updated 12 min ago" by the
 * totals, a small amber dot before it only when a source is overdue for its cadence, and each
 * number's own read and lag in its tooltip. The words use the client's clock, so the server's render
 * may be a minute off.
 */

/** A total's figure, focusable, with when it was read (and its source's lag) on hover or focus */
export function Figure({ label, value, age }: { label: string; value: number; age: TotalAge | undefined }) {
  if (!age) return <>{number(value)}</>;
  const words = ageWords(age);
  return (
    <Tooltip content={words}>
      <span tabIndex={0} aria-label={`${label} ${number(value)}, ${words}`} className="k-figure" suppressHydrationWarning>
        {number(value)}
      </span>
    </Tooltip>
  );
}

/** "updated 12 min ago", after an amber dot naming the overdue sources when there are some */
export function Updated({ updated }: { updated: Pick<LaunchUpdated, 'readAt'> & Partial<Pick<LaunchUpdated, 'overdue'>> }) {
  const overdue = updated.overdue ?? [];
  return (
    <>
      {overdue.length > 0 && (
        <Tooltip content={<span className="k-pre">{overdueWords(overdue)}</span>}>
          <span tabIndex={0} className="k-dot k-dot-stale" role="img" aria-label={overdueWords(overdue).replaceAll('\n', '; ')} />
        </Tooltip>
      )}
      <span suppressHydrationWarning>{updatedWords(updated.readAt)}</span>
    </>
  );
}
