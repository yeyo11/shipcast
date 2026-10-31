import { Link } from '@tanstack/react-router';
import { full } from '../charts/data';
import { Icon } from '../kit/Icon';
import type { RankedEntry } from '../../server/stats.server';
import type { RankBy, StatsSearch } from '../../server/stats-search';
import { CHANNEL_NAMES, pieceName } from '../../server/view';
import { counted, Glyph } from './parts';

/** The raw numbers beside the score; impressions stay out, as in the score itself (docs/stats.md) */
const COLUMNS = ['views', 'reactions', 'comments', 'shares', 'clicks'] as const;
const BY_NAMES: Record<RankBy, string> = { post: 'Posts', launch: 'Launches', account: 'Accounts' };

/**
 * The ranking (board StatsRanking): posts, launches or accounts by popularity normalised per network,
 * a row each with its raw numbers in the network's own words ("likes", "favourites") and the score,
 * paged. A row links to its launch, or to the account on Channels.
 */
export function Ranking({ by, entries, page, pages, onChange }: { by: RankBy; entries: RankedEntry[]; page: number; pages: number; onChange: (patch: Partial<StatsSearch>) => void }) {
  return (
    <section aria-label="Ranking">
      <div className="k-px stats-gap12">
        <div className="k-seg" role="radiogroup" aria-label="Rank">
          {(Object.keys(BY_NAMES) as RankBy[]).map((b) => (
            <button key={b} type="button" role="radio" aria-checked={by === b} className={by === b ? 'k-on' : undefined} onClick={() => onChange({ rank: b, page: undefined })}>
              {BY_NAMES[b]}
            </button>
          ))}
        </div>
      </div>
      <p className="k-px k-xs k-muted stats-rank-note">Popularity normalised per network, so a Mastodon post and a LinkedIn post compare fairly. Impressions stay out.</p>
      {entries.length === 0 ? (
        <p className="k-px k-sm k-muted">Nothing to rank in this period with these filters.</p>
      ) : (
        <ol className="k-px stats-rank">
          {entries.map((e) => (
            <li key={`${e.rank}-${e.postId ?? ''}-${e.launchId ?? ''}-${e.accountId ?? ''}-${e.channel ?? ''}`} className="k-row">
              <span className={`k-d k-d30 stats-rank-n${e.rank === 1 ? ' stats-rank-first' : ''}`}>{e.rank}</span>
              <div className="k-grow k-stack k-g4">
                <strong className="k-sm k-hrow k-g6">
                  <Glyph channel={e.channel} />
                  <Who entry={e} by={by} />
                </strong>
                <span className="k-xs k-muted">{summary(e, by)}</span>
              </div>
              <div className="k-stack stats-rank-score">
                <span className="k-mono">{e.score.toFixed(2)}</span>
                <span className="k-xs k-muted">score</span>
              </div>
            </li>
          ))}
        </ol>
      )}
      {pages > 1 && (
        <nav className="k-px k-hrow k-between stats-gap12" aria-label="Ranking pages">
          <button type="button" className="k-btn k-sm" disabled={page <= 1} onClick={() => onChange({ page: page - 1 > 1 ? page - 1 : undefined })}>
            <Icon name="chevronLeft" size={18} />
            Previous
          </button>
          <span className="k-xs k-muted">
            {page} of {pages}
          </span>
          <button type="button" className="k-btn k-sm" disabled={page >= pages} onClick={() => onChange({ page: page + 1 })}>
            Next
          </button>
        </nav>
      )}
    </section>
  );
}

/** A row's numbers in its network's words, the zeros left out */
function summary(e: RankedEntry, by: RankBy): string {
  const parts = COLUMNS.flatMap((c) => {
    const v = e.metrics[c];
    return v ? [counted(v, e.words[c] ?? c)] : [];
  });
  if (by !== 'post') parts.push(counted(e.pieces, 'pieces'));
  return parts.length > 0 ? parts.join(' · ') : 'Nothing grew in this period';
}

function Who({ entry, by }: { entry: RankedEntry; by: RankBy }) {
  const piece = entry.kind && entry.kind !== 'post' && entry.kind !== 'pieces' ? (entry.kind === 'site' ? 'site' : pieceName(entry.kind)) : '';
  const where = by === 'post' && entry.channel ? ` · ${CHANNEL_NAMES[entry.channel] ?? entry.channel}${piece ? ` ${piece}` : ''}` : '';
  const text = `${entry.title}${where}`;
  if (by === 'account' && entry.accountId !== null) {
    return (
      <Link className="stats-link k-ellipsis" to="/channels" search={{ focus: String(entry.accountId) }}>
        {text}
      </Link>
    );
  }
  if (entry.launchId !== null) {
    return (
      <Link className="stats-link k-ellipsis" to="/launches/$id" params={{ id: String(entry.launchId) }}>
        {text}
      </Link>
    );
  }
  return <span className="k-ellipsis">{text}</span>;
}

/** The desktop's "Top this period" (board DesktopStats): the three most popular pieces and a way to the rest */
export function Top({ entries, onAll }: { entries: RankedEntry[]; onAll: () => void }) {
  return (
    <section className="k-card stats-top" aria-labelledby="stats-top">
      <strong id="stats-top" className="stats-top-title">
        Top this period
      </strong>
      {entries.length === 0 ? (
        <p className="k-sm k-muted">Nothing to rank yet.</p>
      ) : (
        <ol className="stats-top-list">
          {entries.map((e) => (
            <li key={e.rank} className="k-row">
              <span className={`k-d k-d30 stats-rank-n${e.rank === 1 ? ' stats-rank-first' : ''}`}>{e.rank}</span>
              <span className="k-sm k-grow k-hrow k-g6">
                <Glyph channel={e.channel} />
                {e.launchId !== null ? (
                  <Link className="stats-link k-ellipsis" to="/launches/$id" params={{ id: String(e.launchId) }}>
                    {e.title}
                  </Link>
                ) : (
                  <span className="k-ellipsis">{e.title}</span>
                )}
              </span>
              <span className="k-mono k-sm">{full(Number(e.score.toFixed(2)))}</span>
            </li>
          ))}
        </ol>
      )}
      <button type="button" className="k-sm stats-top-all" onClick={onAll}>
        The whole ranking
      </button>
    </section>
  );
}
