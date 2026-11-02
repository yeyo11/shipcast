import { createFileRoute, Link, notFound, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { TopBar } from '../../../components/kit/Bars';
import { Icon } from '../../../components/kit/Icon';
import { articleLine, langName, langOf, langsOf, splitDraft } from '../../../components/approve/model';
import { isLanguage, type Language } from '@shipcast/schema/languages';
import type { DraftView } from '../../../components/approve/parts';
import { useToast } from '../../../components/Toasts';
import { launchName } from '../../../server/launch-list';
import { findSitePreview, getLaunch, previewOnSite } from '../../../server/launches.functions';

/*
 * The article as the site will show it (board LaunchPreview): built here from the drafts, in each of
 * its languages, with the real site's preview behind it (docs/app-review.md): asked for on demand,
 * opened in the browser once the site has deployed it.
 */

interface PreviewSearch {
  lang?: Language;
}

export const Route = createFileRoute('/_app/launches/$id_/preview')({
  validateSearch: (search: Record<string, unknown>): PreviewSearch => (isLanguage(search.lang) ? { lang: search.lang } : {}),
  loader: async ({ params }) => {
    const data = await getLaunch({ data: Number(params.id) });
    if (!data) throw notFound();
    return data;
  },
  head: ({ loaderData }) => ({ meta: [{ title: `Preview · ${loaderData ? launchName(loaderData.launch) : 'Launch'} · Shipcast` }] }),
  component: PreviewPage,
});

function PreviewPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { launch, review } = data;
  const reviewOk = review && !('error' in review) ? review : undefined;
  const app = reviewOk?.app;
  const articles: DraftView[] = reviewOk?.drafts.filter((d) => d.kind === 'article') ?? [];
  // The switch offers the article's languages, whichever they are; English first when it has it, as every channel links
  const langs = langsOf(articles);
  const lang = search.lang && langs.includes(search.lang) ? search.lang : (langs.includes('en') ? 'en' : langs[0]);
  const article = articles.find((a) => langOf(a.path) === lang) ?? articles[0];
  const preview = app?.preview;
  const ready = Boolean(preview?.url && preview.urlSha && preview.sha.startsWith(preview.urlSha));
  const back = launchName(launch);
  const params = { id: String(launch.id) };

  const site = async (find: boolean) => {
    setBusy(true);
    const answer = await (find ? findSitePreview : previewOnSite)({ data: launch.id }).catch((error: unknown) => ({ ok: false as const, problem: error instanceof Error ? error.message : String(error) }));
    setBusy(false);
    if (!answer.ok) toast.fail(answer.problem);
    else if (!find) toast.done('Preview asked for', 'The site builds it in a few minutes; its address shows here once it is up.');
    else if (!answer.preview.url) toast.done('Not up yet', 'The site is still building the preview.');
    await router.invalidate();
  };

  const body = article ? splitDraft(article.content ?? '', 'article').body : '';
  const address = ready && preview?.url ? preview.url.replace(/^https?:\/\//, '') : preview ? 'The site is building the preview…' : 'Built here from the drafts: not on the site yet';

  const content = (
    <div className="k-stack k-g12">
      <div className="k-hrow k-between">
        <h1 className="k-d k-d30">Preview</h1>
        {langs.length > 1 && (
          <div className="k-seg ap-seg" role="group" aria-label="Language">
            {langs.map((l) => (
              <button key={l} type="button" className={l === lang ? 'k-on' : undefined} aria-pressed={l === lang} aria-label={langName(l)} onClick={() => navigate({ search: { lang: l }, replace: true, resetScroll: false })}>
                {l.toUpperCase()}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="k-sm k-muted ap-m0">The article as it will look on the site, built from the drafts. Not public: only this link opens it.</p>
      {article?.preview ? (
        <article className="ap-browser" aria-label="The article as the site shows it" lang={lang}>
          <div className="ap-browser-bar k-ellipsis">{address}</div>
          <div className="ap-browser-page" tabIndex={0} role="region" aria-label="The article, scrollable" data-lenis-prevent>
            <div className="ap-browser-date">{articleLine(article.content ?? '', body)}</div>
            <h2 className="ap-browser-title">{article.preview.title}</h2>
            {article.preview.image && <img className="ap-browser-image" src={article.preview.image} alt={article.preview.imageAlt ?? ''} loading="lazy" />}
            {/* Rendered on the server, any HTML in the draft shown as text */}
            <div className="ap-browser-body" dangerouslySetInnerHTML={{ __html: article.preview.html }} />
          </div>
        </article>
      ) : (
        <div className="k-card k-quiet">
          <strong>No article to preview</strong>
          <span className="k-sm k-muted">This launch has no article among its drafts.</span>
        </div>
      )}
      {app && (
        <div className="k-hrow k-g8 k-wrap">
          {ready && preview?.url && (
            <a className="k-btn k-sm" href={preview.url} target="_blank" rel="noreferrer">
              <Icon name="external" size={18} />
              Open in the browser
              <span className="visually-hidden"> (opens in a new tab)</span>
            </a>
          )}
          {preview && !ready && (
            <button type="button" className="k-btn k-sm" disabled={busy} onClick={() => site(true)}>
              <Icon name="search" size={18} />
              Find its address
            </button>
          )}
          <button type="button" className="k-btn k-sm" disabled={busy} onClick={() => site(false)} title="Puts the article and its media on a preview branch of the launches repo, which the site deploys to its own address">
            <Icon name="retry" size={18} />
            {preview ? 'Update the preview' : 'Preview on the real site'}
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="ap-screen">
      <div className="k-phone">
        <TopBar back={{ label: back, to: `/launches/${launch.id}` }} />
        <div className="k-px ap-preview-phone">{content}</div>
        <div className="ap-mt14" aria-hidden="true" />
      </div>
      <div className="k-desktop">
        <div className="k-page ap-preview-desk">
          <Link to="/launches/$id" params={params} className="k-hrow k-g4 k-sm ap-crumb">
            <Icon name="chevronLeft" size={16} />
            {back}
          </Link>
          <div className="ap-mt12">{content}</div>
        </div>
      </div>
    </div>
  );
}
