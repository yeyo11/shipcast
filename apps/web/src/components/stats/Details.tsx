import type { AverageMetric, DetailMetric } from '@shipcast/schema';
import { deltaLabel, full } from '../charts/data';
import type { StatsView } from '../../server/stats.server';

/** The second tier's names, as the networks' own screens call them */
export const DETAIL_NAMES: Record<DetailMetric, string> = {
  saves: 'Saves',
  reach: 'Reach',
  interactions: 'Interactions',
  follows: 'Follows',
  profileVisits: 'Profile visits',
  navigation: 'Story navigation',
  watchMinutes: 'Minutes watched',
  engagedViews: 'Engaged views',
  visits: 'Visits',
  clones: 'Clones',
  unsubscribes: 'Unsubscribes',
};

/** Each average's name and how its unit reads (definition.ts gives every average one unit) */
const AVERAGES: Record<AverageMetric, { name: string; format: (value: number) => string }> = {
  avgViewSeconds: { name: 'Average view duration', format: (v) => `${v.toFixed(0)} s` },
  avgViewPercent: { name: 'Average percentage viewed', format: (v) => `${v.toFixed(1)}%` },
  avgReadSeconds: { name: 'Average read time', format: (v) => `${v.toFixed(0)} s` },
  avgWatchMs: { name: 'Average watch time', format: (v) => `${(v / 1000).toFixed(1)} s` },
  skipRate: { name: 'Skip rate', format: (v) => `${v.toFixed(1)}%` },
  upvoteRatio: { name: 'Upvote ratio', format: (v) => v.toFixed(2) },
  ctr: { name: 'Click-through rate', format: (v) => `${(v * 100).toFixed(1)}%` },
  position: { name: 'Average position', format: (v) => v.toFixed(1) },
};

/** The search engines count a launch's pages together: their averages are over launches */
const SITE_WIDE = new Set(['search', 'bing']);

/**
 * The numbers past the six families: the second tier (saves, reach, watch time…), added up like the
 * six but neither charted nor scored, with what grew in the period and where it stood at its end;
 * then the averages and ratios, which are never added up, as the period ends (docs/stats.md). Not on
 * the board: kept under the overview as one more card, in the board's rows.
 */
export function Details({ details, averages }: { details: StatsView['details']; averages: StatsView['averages'] }) {
  if (details.length === 0 && averages.length === 0) return null;
  return (
    <section className="k-card stats-details" aria-labelledby="details-title">
      <strong id="details-title">More numbers</strong>
      <p className="k-xs k-muted stats-details-lead">What only some networks count, in this period and in all.</p>
      <ul className="stats-details-list">
        {details.map((d) => {
          const delta = d.previous !== null ? deltaLabel(d.value, d.previous) : null;
          return (
            <li key={d.metric} className="k-row">
              <div className="k-grow k-stack">
                <span className="k-sm">{DETAIL_NAMES[d.metric]}</span>
                <span className="k-xs k-muted">{d.channels.map((c) => `${c.label} ${full(c.value)}`).join(' · ')}</span>
              </div>
              <div className="k-stack stats-details-num">
                <span className="k-mono k-sm">
                  {full(d.value)}
                  {delta && <span className="k-xs k-muted"> {delta.text}</span>}
                </span>
                <span className="k-xs k-muted">{full(d.lifetime)} in all</span>
              </div>
            </li>
          );
        })}
        {averages.map((a) => (
          <li key={`${a.source}.${a.metric}`} className="k-row">
            <div className="k-grow k-stack">
              <span className="k-sm">{AVERAGES[a.metric].name}</span>
              <span className="k-xs k-muted">
                {a.label} · over {a.pieces} {SITE_WIDE.has(a.source) ? (a.pieces === 1 ? 'launch' : 'launches') : a.pieces === 1 ? 'piece' : 'pieces'}
              </span>
            </div>
            <span className="k-mono k-sm">{AVERAGES[a.metric].format(a.value)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
