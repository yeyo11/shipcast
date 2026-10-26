import { useRef, type KeyboardEvent } from 'react';
import { deltaLabel, full } from '../charts/data';
import { METRICS, type Metric } from '../../server/stats-search';
import { METRIC_NAMES } from './FilterBar';

type Totals = Partial<Record<Metric, number>>;

/**
 * The period's totals, one per family the sources count, with the change against the previous
 * period when comparing. The strip is also the chart's metric switch, so it is a radio group: one
 * family is charted at a time, arrows move between them as in any radio group. The change is a word
 * and an arrow, never a colour: green and red would read as good and bad, and in Cartel red only
 * means failure.
 */
export function Kpis({ totals, previous, metric, onPick }: { totals: Totals; previous: Totals | null; metric: Metric; onPick: (m: Metric) => void }) {
  const list = useRef<HTMLDivElement>(null);
  const shown = METRICS.filter((m) => totals[m] !== undefined);
  if (shown.length === 0) return null;
  // A metric the sources picked do not count is still in the address: the first one shown takes the tab stop
  const focusable = shown.includes(metric) ? metric : shown[0];
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    const to = event.key === 'Home' ? 0 : event.key === 'End' ? shown.length - 1 : step !== 0 ? (index + step + shown.length) % shown.length : null;
    if (to === null) return;
    event.preventDefault();
    const next = shown[to];
    if (!next) return;
    onPick(next);
    list.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[to]?.focus();
  };
  return (
    <div ref={list} className="kpis" role="radiogroup" aria-label="Metric shown in the chart">
      {shown.map((m, i) => {
        const value = totals[m] ?? 0;
        const delta = previous ? deltaLabel(value, previous[m] ?? 0) : null;
        return (
          <button key={m} type="button" role="radio" className="kpi" aria-checked={metric === m} tabIndex={m === focusable ? 0 : -1} onClick={() => onPick(m)} onKeyDown={(e) => onKeyDown(e, i)}>
            <span className="kpi-label">{METRIC_NAMES[m]}</span>
            <span className="kpi-value">{full(value)}</span>
            {delta && (
              <span className={`kpi-delta ${delta.direction}`}>
                <span aria-hidden="true">{delta.direction === 'up' ? '▲' : delta.direction === 'down' ? '▼' : '■'}</span> {delta.text}
                <span className="visually-hidden"> against the previous period ({full(previous?.[m] ?? 0)})</span>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
