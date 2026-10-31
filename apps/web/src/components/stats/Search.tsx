import { Link } from '@tanstack/react-router';
import { full, shortDay } from '../charts/data';
import { OnboardMeasure } from '../illustrations';
import type { getSearch } from '../../server/stats.functions';
import { StatsEmpty } from './parts';

type SearchData = Awaited<ReturnType<typeof getSearch>>;
type LaunchRow = SearchData['launches'][number];
type Engine = 'google' | 'bing';

/**
 * The blog's articles in Google and Bing (board StatsSearch, docs/search-indexing.md): a row per
 * published launch with an engine pill each, light when every page of its article is indexed, yellow
 * while one waits, dashed before the engine was asked; then what each engine counted in the period.
 * The engines count a launch's pages together, so their numbers are added up over the launches.
 */
export function Search({ data, period, position }: { data: SearchData; period: string; position: number | null }) {
  if (data.launches.length === 0) {
    return (
      <StatsEmpty
        art={<OnboardMeasure width={240} />}
        title="No articles in search yet"
        actions={
          <Link className="k-btn" to="/channels">
            Go to Channels
          </Link>
        }
      >
        Once a launch publishes its blog article, Google Search Console and Bing Webmaster Tools are asked about each language's page every few hours. Connect them in Channels.
      </StatsEmpty>
    );
  }
  const sum = (engine: Engine) => {
    const read = data.launches.flatMap((l) => (l[engine] ? [l[engine]] : []));
    return read.length === 0 ? null : read.reduce((a, n) => ({ impressions: a.impressions + n.impressions, clicks: a.clicks + n.clicks }), { impressions: 0, clicks: 0 });
  };
  const google = sum('google');
  const bing = sum('bing');
  return (
    <section aria-label="Articles in search engines">
      <ul className="k-px k-stack stats-gap12 stats-search">
        {data.launches.map((l) => (
          <li key={l.id} className="k-row">
            <div className="k-grow k-stack">
              <Link className="k-sm stats-link stats-strong" to="/launches/$id" params={{ id: String(l.id) }}>
                {l.title}
              </Link>
              <span className="k-xs k-muted">{l.pages.length === 0 ? 'No article' : `${l.publishedOn ? `${shortDay(l.publishedOn)} · ` : ''}${languages(l)}`}</span>
            </div>
            {l.pages.length === 0 ? (
              <span className="k-xs k-muted">Nothing to index</span>
            ) : (
              <div className="k-hrow k-g6">
                <EnginePill row={l} engine="google" />
                <EnginePill row={l} engine="bing" />
              </div>
            )}
          </li>
        ))}
      </ul>
      {google && <Numbers title={`From Search Console, ${period.toLowerCase()}`} clicks={google.clicks} impressions={google.impressions} position={position} />}
      {bing && <Numbers title={`From Bing Webmaster Tools, ${period.toLowerCase()}`} clicks={bing.clicks} impressions={bing.impressions} position={null} />}
    </section>
  );
}

function languages(l: LaunchRow): string {
  const langs = [...new Set(l.pages.map((p) => p.lang.toUpperCase()))];
  return langs.length <= 1 ? (langs[0] ?? '') : `${langs.slice(0, -1).join(', ')} and ${langs.at(-1)}`;
}

const ENGINE_NAMES: Record<Engine, string> = { google: 'Google', bing: 'Bing' };

/** One engine for one article: indexed everywhere (light), waiting on a page (yellow), not asked yet (dashed) */
function EnginePill({ row, engine }: { row: LaunchRow; engine: Engine }) {
  const reads = row.pages.map((p) => p[engine]);
  const indexed = reads.length > 0 && reads.every((r) => r?.indexed);
  const unchecked = reads.every((r) => r === null);
  const state = indexed ? 'indexed' : unchecked ? 'not checked yet' : 'waiting to be indexed';
  const said = reads.flatMap((r, i) => (r ? [`${row.pages[i]?.lang.toUpperCase()}: ${r.coverage}`] : [])).join('; ');
  return (
    <span className={`k-pill ${indexed ? 'k-p-pub' : unchecked ? 'k-p-quiet' : 'k-p-wait'}`} title={said || undefined}>
      {ENGINE_NAMES[engine]}
      <span className="visually-hidden">: {state}</span>
    </span>
  );
}

function Numbers({ title, clicks, impressions, position }: { title: string; clicks: number; impressions: number; position: number | null }) {
  return (
    <div className="k-px stats-gap14">
      <section className="k-card stats-search-card" aria-label={title}>
        <span className="k-lbl">{title}</span>
        <div className="k-hrow k-g24">
          <div className="k-stack">
            <span className="k-d k-d30">{full(clicks)}</span>
            <span className="k-xs k-muted">Clicks</span>
          </div>
          <div className="k-stack">
            <span className="k-d k-d30">{full(impressions)}</span>
            <span className="k-xs k-muted">Impressions</span>
          </div>
          {position !== null && (
            <div className="k-stack">
              <span className="k-d k-d30">{position.toFixed(1)}</span>
              <span className="k-xs k-muted">Avg. position</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
