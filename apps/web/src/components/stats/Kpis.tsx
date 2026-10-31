import { useRef, type KeyboardEvent } from 'react';
import { deltaLabel, full } from '../charts/data';
import { METRICS, type Metric } from '../../server/stats-search';
import { METRIC_NAMES } from './parts';

type Totals = Partial<Record<Metric, number>>;

/**
 * The period's totals (board StatsOverview and DesktopStats): a card per family the sources count,
 * each with how it moved against the period before. The cards are also the chart's metric switch,
 * so they are a radio group: the charted one is the light card, arrows move between them. The change
 * is a sign and a number, never a colour: in Cartel red only means failure.
 */
export function Kpis({ totals, previous, days, metric, onPick }: { totals: Totals; previous: Totals | null; days: number; metric: Metric; onPick: (m: Metric) => void }) {
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
    <div ref={list} className="stats-kpis" role="radiogroup" aria-label="Number shown in the chart">
      {shown.map((m, i) => {
        const value = totals[m] ?? 0;
        const delta = previous ? deltaLabel(value, previous[m] ?? 0) : null;
        const on = metric === m;
        return (
          <button key={m} type="button" role="radio" className="stats-kpi" aria-checked={on} tabIndex={m === focusable ? 0 : -1} onClick={() => onPick(m)} onKeyDown={(e) => onKeyDown(e, i)}>
            <span className="stats-kpi-label">{METRIC_NAMES[m]}</span>
            <span className="k-d stats-kpi-value">{full(value)}</span>
            <span className="k-xs stats-kpi-delta">
              {delta ? delta.text : '—'}
              {on && delta && delta.text !== 'new' && delta.text !== '—' && ` on the ${days} days before`}
              <span className="visually-hidden"> against the period before ({full(previous?.[m] ?? 0)})</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
