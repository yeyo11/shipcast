import { createFileRoute, Link, notFound, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Jobs } from '../../../components/Jobs';
import { LaunchCard } from '../../../components/LaunchCard';
import { EmptyDrafts } from '../../../components/illustrations';
import { Empty, PageHead } from '../../../components/PageHead';
import { useToast } from '../../../components/Toasts';
import { Notice, number, Pill, Problem, when } from '../../../components/ui';
import { approveDrafts, getLaunch, publishAgain, saveDraft } from '../../../server/launches.functions';
import { CHANNEL_NAMES } from '../../../server/view';

export const Route = createFileRoute('/_app/launches/$id')({
  loader: async ({ params }) => {
    const data = await getLaunch({ data: Number(params.id) });
    if (!data) throw notFound();
    return data;
  },
  head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.launch.repo ?? 'Launch'} · Shipcast` }] }),
  component: LaunchPage,
});

type Data = Awaited<ReturnType<typeof getLaunch>> & {};
type Review = Exclude<Data['review'], null | { error: string }>;
type DraftView = Review['drafts'][number];

function DraftEditor({ launchId, draft, editable }: { launchId: number; draft: DraftView; editable: boolean }) {
  const router = useRouter();
  const [content, setContent] = useState(draft.content ?? '');
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const changed = content !== (draft.content ?? '');
  // Channel texts are short and read first; articles and what already went out stay folded
  return (
    <details className="draft" open={editable && draft.kind === 'channel'}>
      <summary>
        <h3 className="ph">{draft.label}</h3>
        <span className="muted mono break draft-path">{draft.path}</span>
      </summary>
      {editable ? (
        <>
          <label className="visually-hidden" htmlFor={draft.path}>
            {draft.label}
          </label>
          <textarea id={draft.path} className={`textarea mono${draft.kind === 'article' ? ' tall' : ''}`} value={content} onChange={(e) => setContent(e.target.value)} />
          <div className="row">
            <button
              className="btn btn-small"
              disabled={!changed || busy}
              onClick={async () => {
                setBusy(true);
                const answer = await saveDraft({ data: { id: launchId, path: draft.path, content } });
                setBusy(false);
                if (answer.ok) toast.done(`${draft.label} saved`, 'The edit is a commit on the pull request: it is what gets published.');
                else toast.fail(answer.problem);
                if (answer.ok) await router.invalidate();
              }}
            >
              {busy ? 'Saving…' : 'Save this edit'}
            </button>
          </div>
        </>
      ) : (
        <div className="preview">{draft.content}</div>
      )}
    </details>
  );
}

function LaunchPage() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { launch, review, metrics, index, jobs } = data;
  const running = jobs.some((j) => j.state === 'running') || launch.status === 'generating';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => router.invalidate(), 5000);
    return () => clearInterval(timer);
  }, [running, router]);

  const reviewOk = review && !('error' in review) ? review : undefined;
  const open = reviewOk?.pullRequest.state === 'open';
  const texts = reviewOk?.drafts.filter((d) => d.kind === 'article' || d.kind === 'channel') ?? [];
  const media = reviewOk?.drafts.filter((d) => d.kind === 'image' || d.kind === 'video') ?? [];
  const bySource = new Map<string, typeof metrics>();
  for (const m of metrics) bySource.set(m.source, [...(bySource.get(m.source) ?? []), m]);

  return (
    <>
      <PageHead
        title={launch.ref.startsWith('article:') ? 'Article' : launch.repo.split('/')[1]}
        action={
          <div className="row">
            <Pill tone={launch.state.tone}>{launch.state.label}</Pill>
            <Link className="btn" to="/">
              All launches
            </Link>
          </div>
        }
      >
        {launch.repo} · <span className="mono break">{launch.ref}</span> · {launch.kind} · started {when(launch.createdAt)}
      </PageHead>
      <Jobs jobs={jobs} />
      {launch.problem && (
        <Notice tone="bad">
          <strong>The launch failed.</strong>
          <div className="preview">{launch.problem}</div>
        </Notice>
      )}

      {open && (
        <div className="band band-yellow">
          <h2 className="ph" style={{ margin: 0 }}>
            Waiting for you
          </h2>
          <p className="muted" style={{ margin: '10px 0 20px' }}>
            Read and edit every piece below. Approving merges the pull request: the blog publishes, then every approved channel.
          </p>
          <div className="row">
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const answer = await approveDrafts({ data: launch.id });
                setBusy(false);
                if (answer.ok) toast.done('Approved', 'The pull request is merged; the blog deploys, then every channel publishes.');
                else toast.fail(answer.problem);
                await router.invalidate();
              }}
            >
              {busy ? 'Approving…' : `Approve and publish ${texts.filter((t) => t.kind === 'channel').length + 1} pieces`}
            </button>
            {reviewOk && (
              <a className="btn" href={reviewOk.pullRequest.url} target="_blank" rel="noreferrer" style={{ color: '#000', borderColor: '#000' }}>
                Open the pull request
              </a>
            )}
          </div>
        </div>
      )}

      {(launch.posts.length > 0 || launch.failures.length > 0) && <LaunchCard launch={launch} />}

      {launch.failures.length > 0 && (
        <>
          <h2 className="ph">Failed channels</h2>
          <ul className="list">
            {launch.failures.map((f) => (
              <li key={f.channel}>
                <div>
                  <strong>{CHANNEL_NAMES[f.channel] ?? f.channel}</strong>
                  <Problem text={f.message} />
                </div>
                <button
                  className="btn btn-small"
                  onClick={async () => {
                    const answer = await publishAgain({ data: { id: launch.id, channel: f.channel } });
                    if (answer.ok) toast.done(`Trying ${CHANNEL_NAMES[f.channel] ?? f.channel} again`);
                    else toast.fail(answer.problem);
                    await router.invalidate();
                  }}
                >
                  Try again
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {launch.status === 'drafted' && !open && !running && (
        <div className="row" style={{ marginBlock: 24 }}>
          <button
            className="btn"
            onClick={async () => {
              const answer = await publishAgain({ data: { id: launch.id } });
              if (answer.ok) toast.done('Publishing what is still pending');
              else toast.fail(answer.problem);
              await router.invalidate();
            }}
          >
            Publish what is pending
          </button>
        </div>
      )}

      {review && 'error' in review && <Notice tone="bad">Could not read the drafts: {review.error}</Notice>}
      {texts.length === 0 && launch.posts.length === 0 && !launch.problem && (
        <Empty art={<EmptyDrafts width={260} />} title={running ? 'Drafting…' : 'No drafts here'}>
          {running
            ? 'Shipcast is reading the code and writing each piece; the drafts show here when they are ready.'
            : reviewOk
              ? 'The pull request has no texts to review.'
              : 'Nothing was drafted for this launch yet.'}
        </Empty>
      )}
      {texts.length > 0 && (
        <>
          <h2 className="ph">{open ? 'The drafts' : 'What went out'}</h2>
          <div style={{ display: 'grid', gap: 18 }}>
            {texts.map((d) => (
              <DraftEditor key={d.path} launchId={launch.id} draft={d} editable={open} />
            ))}
          </div>
        </>
      )}
      {media.length > 0 && (
        <>
          <h2 className="ph">Media</h2>
          <div className="thumbs">
            {media.map((m) =>
              m.kind === 'video' ? (
                <video key={m.path} src={m.url} controls muted style={{ height: 180, borderRadius: 12 }} />
              ) : (
                <a key={m.path} href={m.url} target="_blank" rel="noreferrer">
                  <img src={m.url} alt={m.label} loading="lazy" />
                </a>
              ),
            )}
          </div>
        </>
      )}

      {index.length > 0 && (
        <>
          <h2 className="ph">In search engines</h2>
          <table className="table">
            <tbody>
              {index.map((i) => (
                <tr key={`${i.engine} ${i.url}`}>
                  <th scope="row">
                    {i.engine === 'bing' ? 'Bing' : 'Google'},{' '}
                    <a href={i.url} target="_blank" rel="noreferrer">
                      {i.lang === 'es' ? 'Spanish' : 'English'}
                    </a>
                  </th>
                  <td>
                    {i.indexed === null ? (
                      <span className="muted">Not checked yet: the next metrics reading asks Google</span>
                    ) : (
                      <>
                        <Pill tone={i.indexed ? 'published' : 'waiting'}>
                          {i.engine === 'bing' ? (i.indexed ? 'Crawled' : 'Not crawled yet') : i.indexed ? 'Indexed' : 'Not indexed yet'}
                        </Pill>{' '}
                        <span className="muted">{i.coverage}</span>
                      </>
                    )}
                  </td>
                  <td className="muted">{i.checkedAt ? `checked ${when(i.checkedAt)}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {metrics.length > 0 && (
        <>
          <h2 className="ph">Numbers</h2>
          <div className="cards">
            {[...bySource].map(([source, values]) => (
              <article className="card" key={source}>
                <h3 className="ph">{CHANNEL_NAMES[source] ?? source}</h3>
                <table className="table">
                  <tbody>
                    {values.map((v) => (
                      <tr key={v.name}>
                        <th scope="row">{v.name.replace(/_/g, ' ')}</th>
                        <td className="num">{number(v.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="muted">read {when(values[0]!.takenAt)}</p>
              </article>
            ))}
          </div>
        </>
      )}
    </>
  );
}
