import { Link } from '@tanstack/react-router';
import { full } from '../charts/data';
import { ChannelName } from '../ui';
import { pieceName } from '../../server/view';
import type { RankBy, Sort, StatsSearch } from '../../server/stats-search';
import { METRIC_NAMES } from './FilterBar';

export interface RankingEntryView {
  rank: number;
  score: number;
  metrics: Partial<Record<Exclude<Sort, 'score'>, number>>;
  /** Where the same numbers stood at the period's end, as the network's own screen shows them */
  lifetime: Partial<Record<Exclude<Sort, 'score'>, number>>;
  pieces: number;
  channel: string | null;
  launchId: number | null;
  postId: number | null;
  accountId: number | null;
  label: string;
  url: string | null;
  kind: string | null;
}

export interface RankingTableProps {
  by: RankBy;
  sort: Sort;
  order: 'asc' | 'desc';
  entries: RankingEntryView[];
  page: number;
  pages: number;
  total: number;
  onChange: (patch: Partial<StatsSearch>) => void;
}

/** The raw columns beside the score; impressions stay out, as in the score itself (docs/stats.md) */
const COLUMNS = ['views', 'reactions', 'comments', 'shares', 'clicks'] as const;
const BY_NAMES: Record<RankBy, string> = { post: 'Posts', launch: 'Launches', account: 'Accounts' };

/**
 * The ranking: posts, launches or accounts by popularity normalised per network,
 * with the raw numbers beside the score, sortable by any column and paged. A row names its launch
 * and links to the launch's page; a post also links out to where it was published.
 */
export function RankingTable({ by, sort, order, entries, page, pages, total, onChange }: RankingTableProps) {
  const sortBy = (column: Sort) => onChange({ sort: column, order: sort === column && order === 'desc' ? 'asc' : 'desc', page: undefined });
  const header = (column: Sort, label: string) => (
    <th scope="col" className="num" aria-sort={sort === column ? (order === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button type="button" className="sort" onClick={() => sortBy(column)}>
        {label}
        <span aria-hidden="true" className="sort-mark">
          {sort === column ? (order === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </button>
    </th>
  );
  return (
    <section className="ranking stats-panel" aria-labelledby="ranking-title">
      <div className="section-head">
        <h2 id="ranking-title" className="stats-panel-title">
          Ranking
        </h2>
        <div className="seg" role="radiogroup" aria-label="Rank">
          {(Object.keys(BY_NAMES) as RankBy[]).map((b) => (
            <label key={b}>
              <input type="radio" name="rank-by" checked={by === b} onChange={() => onChange({ rank: b, page: undefined })} />
              <span>{BY_NAMES[b]}</span>
            </label>
          ))}
        </div>
      </div>
      <p className="muted section-lead">
        A score of 1 is what a typical piece on its network got in the period, 2 twice that, so a like on Bluesky and a visit on dev.to compare. Under each number, its lifetime as the period ends.
      </p>
      {entries.length === 0 ? (
        <p className="muted">Nothing to rank in this period with these filters.</p>
      ) : (
        <div className="table-card">
          <table className="table ranking-table">
            <caption className="visually-hidden">
              {BY_NAMES[by]} ranked by {sort === 'score' ? 'score' : METRIC_NAMES[sort].toLowerCase()}, page {page} of {pages}
            </caption>
            <thead>
              <tr>
                <th scope="col" className="num">
                  #
                </th>
                <th scope="col">{by === 'post' ? 'Post' : by === 'launch' ? 'Launch' : 'Account'}</th>
                {header('score', 'Score')}
                {COLUMNS.map((c) => header(c, METRIC_NAMES[c]))}
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={`${e.rank}-${e.postId ?? ''}-${e.launchId ?? ''}-${e.accountId ?? ''}-${e.channel ?? ''}`}>
                  <td className="num" data-label="Rank">
                    {e.rank}
                  </td>
                  <td className="ranking-who">
                    <Who entry={e} by={by} />
                  </td>
                  <td className="num ranking-score" data-label="Score">
                    {e.score.toFixed(2)}
                  </td>
                  {COLUMNS.map((c) => (
                    <td key={c} className="num" data-label={METRIC_NAMES[c]}>
                      {e.metrics[c] === undefined ? (
                        <span aria-label="not counted">—</span>
                      ) : (
                        <>
                          {full(e.metrics[c] ?? 0)}
                          <span className="stats-life">{full(e.lifetime[c] ?? 0)} lifetime</span>
                        </>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <nav className="pager" aria-label="Ranking pages">
          <button type="button" className="btn btn-small" disabled={page <= 1} onClick={() => onChange({ page: page - 1 > 1 ? page - 1 : undefined })}>
            Previous
          </button>
          <span className="muted">
            Page {page} of {pages} · {total} {BY_NAMES[by].toLowerCase()}
          </span>
          <button type="button" className="btn btn-small" disabled={page >= pages} onClick={() => onChange({ page: page + 1 })}>
            Next
          </button>
        </nav>
      )}
    </section>
  );
}

function Who({ entry, by }: { entry: RankingEntryView; by: RankBy }) {
  const piece = entry.kind && entry.kind !== 'post' && entry.kind !== 'pieces' ? (entry.kind === 'site' ? 'site' : pieceName(entry.kind)) : '';
  const label = (
    <span className="break">
      {entry.label}
      {piece && <span className="muted"> · {piece}</span>}
    </span>
  );
  return (
    <div className="who-cell">
      {entry.channel && (
        <span className="who-channel">
          <ChannelName channel={entry.channel} />
        </span>
      )}
      {by === 'account' && entry.accountId !== null ? (
        <Link to="/channels" search={{ focus: String(entry.accountId) }}>
          {label}
        </Link>
      ) : entry.launchId !== null ? (
        <Link to="/launches/$id" params={{ id: String(entry.launchId) }}>
          {label}
        </Link>
      ) : (
        label
      )}
      {entry.url && by === 'post' && (
        <a className="who-out" href={entry.url} target="_blank" rel="noreferrer noopener">
          Open<span className="visually-hidden"> {entry.label} on {entry.channel ?? 'its network'}</span> ↗
        </a>
      )}
      {by !== 'post' && (
        <span className="muted who-pieces">
          {entry.pieces} {entry.pieces === 1 ? 'piece' : 'pieces'}
        </span>
      )}
    </div>
  );
}
