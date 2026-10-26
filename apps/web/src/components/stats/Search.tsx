import { Link } from '@tanstack/react-router';
import { Fragment } from 'react';
import { full } from '../charts/data';
import { OnboardMeasure } from '../illustrations';
import { Empty } from '../PageHead';
import { when } from '../ui';
import type { getSearch } from '../../server/stats.functions';

type SearchData = Awaited<ReturnType<typeof getSearch>>;
type Engine = SearchData['launches'][number]['pages'][number]['google'];

/**
 * The blog's articles in Google and Bing (docs/search-indexing.md): a row per article page with
 * what each engine last said of it, and the impressions and clicks each engine counted for the
 * launch in the period. The engines count a launch's pages together, so the numbers span its rows.
 */
export function Search({ data }: { data: SearchData }) {
  if (data.launches.length === 0) {
    return (
      <Empty art={<OnboardMeasure width={240} />} title="No articles in search yet" action={<Link className="btn" to="/channels">Go to Channels</Link>}>
        Once a launch publishes its blog article, Google Search Console and Bing Webmaster Tools are asked about each language's page every few hours. Connect them in Channels.
      </Empty>
    );
  }
  return (
    <section className="stats-panel" aria-labelledby="search-title">
      <div className="section-head">
        <h2 id="search-title" className="stats-panel-title">
          Articles in search engines
        </h2>
      </div>
      <p className="muted section-lead">Whether each article is indexed is what the engine said at its last check; impressions and clicks are what each engine counted in the period, for all of a launch's pages.</p>
      <div className="stats-scroll" role="region" aria-labelledby="search-title" tabIndex={0}>
        <table className="table stats-table search-table">
          <thead>
            <tr>
              <th scope="col">Page</th>
              <th scope="col">Google</th>
              <th scope="col">Bing</th>
              <th scope="col" className="num">
                Google impressions
              </th>
              <th scope="col" className="num">
                Google clicks
              </th>
              <th scope="col" className="num">
                Bing impressions
              </th>
              <th scope="col" className="num">
                Bing clicks
              </th>
            </tr>
          </thead>
          <tbody>
            {data.launches.map((l) => (
              <Fragment key={l.id}>
                {l.pages.map((p, i) => (
                  <tr key={p.url} className={i === 0 ? 'search-first' : undefined}>
                    <th scope="row">
                      <span className="search-page">
                        {i === 0 && (
                          <Link className="search-launch" to="/launches/$id" params={{ id: String(l.id) }}>
                            {l.label}
                          </Link>
                        )}
                        <a className="search-url" href={p.url} target="_blank" rel="noreferrer noopener">
                          {new URL(p.url).pathname}
                          <span className="visually-hidden"> (opens the article)</span>
                        </a>
                        <span className="stats-lang">{p.lang.toUpperCase()}</span>
                      </span>
                    </th>
                    <td>
                      <IndexState engine={p.google} yes="Indexed" no="Not indexed yet" />
                    </td>
                    <td>
                      <IndexState engine={p.bing} yes="Crawled" no="Not crawled yet" />
                    </td>
                    {i === 0 && (
                      <>
                        <Count rows={l.pages.length} value={l.google?.impressions} />
                        <Count rows={l.pages.length} value={l.google?.clicks} />
                        <Count rows={l.pages.length} value={l.bing?.impressions} />
                        <Count rows={l.pages.length} value={l.bing?.clicks} />
                      </>
                    )}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function IndexState({ engine, yes, no }: { engine: Engine; yes: string; no: string }) {
  if (!engine) return <span className="muted">Not checked</span>;
  return (
    <span className="search-state" title={`${engine.coverage} · checked ${when(engine.checkedAt)} UTC`}>
      <span className={engine.indexed ? 'search-yes' : 'muted'}>{engine.indexed ? yes : no}</span>
      <small className="muted">{engine.coverage}</small>
    </span>
  );
}

function Count({ rows, value }: { rows: number; value: number | undefined }) {
  return (
    <td className="num" rowSpan={rows}>
      {value === undefined ? <span aria-label="not read">—</span> : full(value)}
    </td>
  );
}
