import { deltaLabel, full } from '../charts/data';
import { METRICS, type Metric } from '../../server/stats-search';
import { METRIC_NAMES } from './ControlBar';

type Totals = Partial<Record<Metric, number>>;

/**
 * The period's totals, one per family the sources count, with the change against the previous
 * period when comparing. Each is also the way to chart that family: pressing one picks it, as in
 * PostHog. The change is a word and an arrow, never a colour: green and red would read as good and
 * bad, and in Cartel red only means failure.
 */
export function Kpis({ totals, previous, metric, onPick }: { totals: Totals; previous: Totals | null; metric: Metric; onPick: (m: Metric) => void }) {
  const shown = METRICS.filter((m) => totals[m] !== undefined);
  if (shown.length === 0) return null;
  return (
    <ul className="kpis" aria-label="Totals in the period">
      {shown.map((m) => {
        const value = totals[m] ?? 0;
        const delta = previous ? deltaLabel(value, previous[m] ?? 0) : null;
        return (
          <li key={m}>
            <button type="button" className="kpi" aria-pressed={metric === m} onClick={() => onPick(m)}>
              <span className="kpi-label">{METRIC_NAMES[m]}</span>
              <span className="kpi-value">{full(value)}</span>
              {delta && (
                <span className={`kpi-delta ${delta.direction}`}>
                  <span aria-hidden="true">{delta.direction === 'up' ? '▲' : delta.direction === 'down' ? '▼' : '■'}</span> {delta.text}
                  <span className="visually-hidden"> against the previous period ({full(previous?.[m] ?? 0)})</span>
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
