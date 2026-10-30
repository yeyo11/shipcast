import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Parcels } from '../../components/illustrations';
import { PageHead } from '../../components/PageHead';
import { useToast } from '../../components/Toasts';
import { Combobox } from '../../components/ui/Combobox';
import { getChannels } from '../../server/channels.functions';
import { launchFromSources, listRepos } from '../../server/launches.functions';
import { CHANNEL_NAMES } from '../../server/view';

/*
 * A launch made from sources (launch-sources, docs/sources.md): the owner's text, pages, repos and
 * images, gathered into one launch. Plain on purpose: the form's look follows Launch a repo and Write
 * until the owner settles one for it.
 */

type Uploaded = { ok: true; file: { sha256: string; mime: string; width: number | null; height: number | null } } | { ok: false; problem: string };

/** The file's bytes as the body (routes/api/sources/media.ts): the server checks the flag and the size before reading it */
async function uploadFile(file: File): Promise<Uploaded> {
  try {
    const response = await fetch('/api/sources/media', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
    if ((response.headers.get('content-type') ?? '').includes('json')) return (await response.json()) as Uploaded;
    return { ok: false, problem: (await response.text()) || `the upload answered ${response.status}` };
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
}

export const Route = createFileRoute('/_app/sources')({
  head: () => ({ meta: [{ title: 'Launch from sources · Shipcast' }] }),
  loader: async () => {
    const [repos, channels] = await Promise.all([listRepos(), getChannels()]);
    const ready = channels.networks.filter((n) => n.channel && n.channel !== 'blog' && (n.accounts.some((a) => a.status === 'ok') || n.usesEnv)).map((n) => n.channel!);
    return { ...repos, ready };
  },
  component: LaunchFromSources,
});

type Kind = 'text' | 'url' | 'repo' | 'media';

type Source =
  | { kind: 'text'; text: string; title?: string }
  | { kind: 'url'; url: string }
  | { kind: 'repo'; repo: string; ref?: string; primary?: boolean }
  | { kind: 'media'; sha256: string; name: string; alt?: string; size: string };

const KINDS: ReadonlyArray<[Kind, string]> = [
  ['text', 'Your text'],
  ['url', 'A page'],
  ['repo', 'A repo'],
  ['media', 'An image'],
];

function describe(source: Source): string {
  if (source.kind === 'text') return source.title ? `${source.title}: ${source.text.slice(0, 80)}` : source.text.slice(0, 100);
  if (source.kind === 'url') return source.url;
  if (source.kind === 'repo') return `${source.repo}${source.ref ? ` at ${source.ref}` : ''}`;
  return `${source.name} (${source.size})${source.alt ? `: ${source.alt}` : ''}`;
}

function LaunchFromSources() {
  const { repos, ready, sources: enabled, appReview } = Route.useLoaderData();
  const navigate = useNavigate();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [lang, setLang] = useState<'en' | 'es'>('es');
  const [channels, setChannels] = useState<string[]>(ready);
  const [sources, setSources] = useState<Source[]>([]);
  const [kind, setKind] = useState<Kind>('text');
  const [draft, setDraft] = useState({ text: '', title: '', url: '', repo: '', ref: '', alt: '' });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const repoOptions = useMemo(() => repos.map((r) => ({ value: r.repo, label: r.repo.split('/')[1] ?? r.repo, hint: r.repo })), [repos]);
  const primary = sources.find((s): s is Extract<Source, { kind: 'repo' }> => s.kind === 'repo' && Boolean(s.primary)) ?? sources.find((s) => s.kind === 'repo');

  if (!enabled) {
    return (
      <>
        <PageHead title="Launch from sources" art={<Parcels width={200} />}>Launches made from your text, pages, repos and images are not turned on here.</PageHead>
        <p className="muted">They are behind the launch-sources flag (SHIPCAST_FLAGS).</p>
      </>
    );
  }

  const add = async () => {
    if (kind === 'text' && draft.text.trim()) setSources([...sources, { kind, text: draft.text, ...(draft.title.trim() && { title: draft.title.trim() }) }]);
    else if (kind === 'url' && draft.url.trim()) setSources([...sources, { kind, url: draft.url.trim() }]);
    else if (kind === 'repo' && draft.repo) setSources([...sources, { kind, repo: draft.repo, ...(draft.ref.trim() && { ref: draft.ref.trim() }) }]);
    else if (kind === 'media' && file) {
      setBusy('Uploading…');
      const answer = await uploadFile(file);
      setBusy(null);
      if (!answer.ok) return toast.fail(answer.problem);
      const size = answer.file.width && answer.file.height ? `${answer.file.width}×${answer.file.height}` : answer.file.mime;
      setSources([...sources, { kind, sha256: answer.file.sha256, name: file.name, size, ...(draft.alt.trim() && { alt: draft.alt.trim() }) }]);
      setFile(null);
    } else return;
    setDraft({ text: '', title: '', url: '', repo: '', ref: '', alt: '' });
  };

  return (
    <>
      <PageHead title="Launch from sources" art={<Parcels width={200} />}>
        Gather what the launch is about: your own words, pages, repos and images. Shipcast reads all of it and every piece says only what a source shows.
      </PageHead>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy('Fetching the pages and starting…');
          const payload = sources.map((s) => (s.kind === 'media' ? { kind: s.kind, sha256: s.sha256, name: s.name, ...(s.alt && { alt: s.alt }) } : s));
          const answer = await launchFromSources({ data: { title, lang, channels, sources: payload } }).catch((error: unknown) => ({
            ok: false as const,
            problem: error instanceof Error ? error.message : String(error),
          }));
          setBusy(null);
          if (answer.ok) {
            toast.done(`Drafting “${title}”`, 'The analysis takes a few minutes; it shows on Launches while it runs.');
            await navigate({ to: '/' });
          } else toast.fail(answer.problem);
        }}
      >
        <div className="field">
          <label htmlFor="title">Title</label>
          <input id="title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label">Written in</legend>
          <div className="seg">
            <label>
              <input type="radio" name="lang" checked={lang === 'es'} onChange={() => setLang('es')} />
              <span>Spanish</span>
            </label>
            <label>
              <input type="radio" name="lang" checked={lang === 'en'} onChange={() => setLang('en')} />
              <span>English</span>
            </label>
          </div>
        </fieldset>

        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label">Sources</legend>
          {sources.length === 0 ? (
            <small>None yet. Add at least one below.</small>
          ) : (
            <ol>
              {sources.map((s, i) => (
                <li key={i}>
                  <div className="row">
                    <span>
                      <strong>{KINDS.find(([k]) => k === s.kind)?.[1]}</strong>
                      {s === primary && ' · primary: its release is the launch'} · {describe(s)}
                    </span>
                    {s.kind === 'repo' && s !== primary && (
                      <button type="button" className="btn-link" onClick={() => setSources(sources.map((x) => (x.kind === 'repo' ? { ...x, primary: x === s } : x)))}>
                        Make primary
                      </button>
                    )}
                    <button type="button" className="btn-link" onClick={() => setSources(sources.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </fieldset>

        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label">Add a source</legend>
          <div className="seg">
            {KINDS.map(([k, label]) => (
              <label key={k}>
                <input type="radio" name="kind" checked={kind === k} onChange={() => setKind(k)} />
                <span>{label}</span>
              </label>
            ))}
          </div>
          {kind === 'text' && (
            <>
              <input className="input" placeholder="What it is (optional)" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} maxLength={200} />
              <textarea className="textarea" placeholder="Notes, a draft, your opinion: Markdown" value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
              <small>Your words are the authority on your opinions and plans; a feature only your text announces is presented as yours to tell, not as working.</small>
            </>
          )}
          {kind === 'url' && (
            <>
              <input className="input" type="url" placeholder="https://" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
              <small>Fetched once by Shipcast when the launch is made: public pages only, HTML or text.</small>
            </>
          )}
          {kind === 'repo' && (
            <>
              <Combobox label="Repository" placeholder="Type a repo’s name" empty="No repo of yours matches." options={repoOptions} value={draft.repo || null} onValueChange={(name) => setDraft({ ...draft, repo: name ?? '' })} />
              <input className="input mono" placeholder="Release, branch or tag (optional)" value={draft.ref} onChange={(e) => setDraft({ ...draft, ref: e.target.value })} maxLength={140} />
              <small>The primary repo’s release is the launch (its latest when none is named) and its launch.yml chooses the channels; other repos are read at their default branch.</small>
            </>
          )}
          {kind === 'media' && (
            <>
              <input className="input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              <input className="input" placeholder="What it shows (alt text)" value={draft.alt} onChange={(e) => setDraft({ ...draft, alt: e.target.value })} maxLength={500} />
              <small>PNG, JPEG, GIF or WebP, up to 20 MB. Its metadata (a photo’s location) is removed before it is kept.</small>
            </>
          )}
          <div className="row">
            <button type="button" className="btn btn-small" onClick={() => void add()} disabled={busy !== null}>
              Add
            </button>
          </div>
        </fieldset>

        {!primary && (
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label">Also on</legend>
            <div className="checks">
              {ready.map((c) => (
                <label className="check" key={c}>
                  <input type="checkbox" checked={channels.includes(c)} onChange={(e) => setChannels(e.target.checked ? [...channels, c] : channels.filter((x) => x !== c))} />
                  {CHANNEL_NAMES[c] ?? c}
                </label>
              ))}
            </div>
            <small>Besides the blog. With a repo, its launch.yml chooses the channels instead.</small>
          </fieldset>
        )}

        {busy && <p className="muted">{busy}</p>}
        <div className="row">
          <button className="btn btn-primary" type="submit" disabled={sources.length === 0 || !title.trim() || busy !== null}>
            Draft the launch
          </button>
          <span className="muted" style={{ fontSize: 14 }}>
            {appReview ? 'The drafts wait in Shipcast until you approve them.' : 'The drafts wait in a pull request until you approve them.'}
          </span>
        </div>
      </form>
    </>
  );
}
