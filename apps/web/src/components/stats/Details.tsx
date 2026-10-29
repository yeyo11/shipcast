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
 * six but neither charted nor scored, with what grew in the period beside where it stood at its end;
 * then the averages and ratios, which are never added up, as the period ends (docs/stats.md).
 */
export function Details({ details, averages, comparing }: { details: StatsView['details']; averages: StatsView['averages']; comparing: boolean }) {
  if (details.length === 0 && averages.length === 0) return null;
  return (
    <section className="stats-panel stats-details" aria-labelledby="details-title">
      <div className="section-head">
        <h2 id="details-title" className="stats-panel-title">
          More numbers
        </h2>
      </div>
      <p className="muted section-lead">What only some networks count. Lifetime is where each number stood at the period’s end, as the network’s own screen shows it.</p>
      {details.length > 0 && (
        <div className="stats-scroll" role="region" aria-label="More numbers, added up" tabIndex={0}>
          <table className="table stats-table">
            <thead>
              <tr>
                <th scope="col">Number</th>
                <th scope="col">From</th>
                <th scope="col" className="num">
                  This period
                </th>
                <th scope="col" className="num">
                  Lifetime
                </th>
              </tr>
            </thead>
            <tbody>
              {details.map((d) => {
                const delta = comparing && d.previous !== null ? deltaLabel(d.value, d.previous) : null;
                return (
                  <tr key={d.metric}>
                    <th scope="row">{DETAIL_NAMES[d.metric]}</th>
                    <td className="stats-details-from">{d.channels.map((c) => `${c.label} ${full(c.value)}`).join(' · ')}</td>
                    <td className="num">
                      {full(d.value)}
                      {delta && (
                        <span className="stats-life">
                          <span aria-hidden="true">{delta.direction === 'up' ? '▲' : delta.direction === 'down' ? '▼' : '■'}</span> {delta.text}
                          <span className="visually-hidden"> against the previous period ({full(d.previous ?? 0)})</span>
                        </span>
                      )}
                    </td>
                    <td className="num">{full(d.lifetime)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {averages.length > 0 && (
        <div className="stats-scroll" role="region" aria-label="Averages as the period ends" tabIndex={0}>
          <table className="table stats-table">
            <thead>
              <tr>
                <th scope="col">Average</th>
                <th scope="col">From</th>
                <th scope="col" className="num">
                  At the period’s end
                </th>
                <th scope="col" className="num">
                  Over
                </th>
              </tr>
            </thead>
            <tbody>
              {averages.map((a) => (
                <tr key={`${a.source}.${a.metric}`}>
                  <th scope="row">{AVERAGES[a.metric].name}</th>
                  <td>{a.label}</td>
                  <td className="num">{AVERAGES[a.metric].format(a.value)}</td>
                  <td className="num">
                    {a.pieces} {SITE_WIDE.has(a.source) ? (a.pieces === 1 ? 'launch' : 'launches') : a.pieces === 1 ? 'piece' : 'pieces'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
