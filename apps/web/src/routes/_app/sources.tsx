import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { TopBar } from '../../components/kit/Bars';
import { Icon } from '../../components/kit/Icon';
import { useToast } from '../../components/Toasts';
import { ActionBar, ChannelChips, LANGS, Seg } from '../../components/write/Form';
import { PickerCombobox, type PickerOption } from '../../components/kit/Picker';
import { getChannels } from '../../server/channels.functions';
import { launchFromSources, listRepos } from '../../server/launches.functions';

/*
 * A launch made from sources (docs/sources.md): the owner's text, pages, repos and
 * images, gathered into one launch (board LaunchSources).
 */

type Uploaded = { ok: true; file: { sha256: string; mime: string; width: number | null; height: number | null } } | { ok: false; problem: string };

/** The file's bytes as the body (routes/api/sources/media.ts): the server checks the size before reading it */
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

/** Each kind's word on its pill and the add form's lines (board LaunchSources) */
const KINDS: Record<Kind, { label: string; help: string }> = {
  text: { label: 'Text', help: 'Your words are the authority on your opinions and plans; a feature only your text announces is presented as yours to tell, not as working.' },
  url: { label: 'Page', help: 'Fetched once when the launch is made: public pages only, HTML or text.' },
  repo: { label: 'Repo', help: 'The primary repo’s release is the launch (its latest when none is named) and its launch.yml chooses the channels; other repos are read at their default branch.' },
  media: { label: 'Image', help: 'PNG, JPEG, GIF or WebP, up to 20 MB. Its location metadata is removed before it is kept.' },
};
const KIND_OPTIONS = (Object.keys(KINDS) as Kind[]).map((k) => ({ value: k, label: KINDS[k].label }));

function describe(source: Source): string {
  if (source.kind === 'text') return source.title ? `${source.title}: ${source.text.slice(0, 80)}` : source.text.slice(0, 100);
  if (source.kind === 'url') return source.url.replace(/^https?:\/\//, '');
  if (source.kind === 'repo') return `${source.repo}${source.ref ? ` at ${source.ref}` : ''}`;
  return `${source.name} (${source.size})${source.alt ? `: ${source.alt}` : ''}`;
}

const EMPTY = { text: '', title: '', url: '', repo: '', ref: '', alt: '' };

function LaunchFromSources() {
  const { repos, ready } = Route.useLoaderData();
  const navigate = useNavigate();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [lang, setLang] = useState<'en' | 'es'>('es');
  const [channels, setChannels] = useState<string[]>(ready);
  const [sources, setSources] = useState<Source[]>([]);
  const [kind, setKind] = useState<Kind>('url');
  const [draft, setDraft] = useState(EMPTY);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const repoOptions = useMemo<PickerOption[]>(() => repos.map((r) => ({ value: r.repo, label: r.repo })), [repos]);
  const primary = sources.find((s): s is Extract<Source, { kind: 'repo' }> => s.kind === 'repo' && Boolean(s.primary)) ?? sources.find((s) => s.kind === 'repo');

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
    } else {
      // Nothing to add yet: the field it needs is where the owner goes
      document.querySelector<HTMLElement>('.wr-add .k-input, .wr-add input')?.focus();
      return;
    }
    setDraft(EMPTY);
  };

  return (
    <>
      <TopBar back={{ label: 'Launch a repo', to: '/launch' }} />
      <div className="wr-page">
        <form
          id="sources-form"
          className="k-stack wr-form"
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
          <h1 className="k-d k-d48">From sources</h1>
          <p className="k-muted wr-flush">Your words, pages, repos and images. Shipcast reads all of it and every piece says only what a source shows.</p>
          <div className="k-field">
            <label className="k-lbl" htmlFor="sources-title">
              Title
            </label>
            <input id="sources-title" className="k-input" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
          </div>
          <div className="k-stack k-g8">
            <span className="k-lbl" id="sources-lang">
              Written in
            </span>
            <Seg label="Written in" options={LANGS} value={lang} onChange={setLang} />
          </div>

          <section className="k-stack k-g8" aria-labelledby="sources-list">
            <span className="k-lbl" id="sources-list">
              Sources · {sources.length}
            </span>
            {sources.length === 0 ? (
              <span className="k-help">None yet. Add at least one below.</span>
            ) : (
              <ol className="k-stack k-g8 wr-sources">
                {sources.map((s, i) => (
                  <li key={i} className="k-card wr-source">
                    <span className="k-pill k-p-line">{KINDS[s.kind].label}</span>
                    <span className="k-grow k-sm k-ellipsis">{describe(s)}</span>
                    {s.kind === 'repo' &&
                      (s === primary ? (
                        <span className="k-xs k-muted">primary</span>
                      ) : (
                        <button type="button" className="k-xs wr-textbutton" onClick={() => setSources(sources.map((x) => (x.kind === 'repo' ? { ...x, primary: x === s } : x)))}>
                          Make primary
                        </button>
                      ))}
                    <button type="button" className="k-btn k-icon k-sm k-ghost" aria-label={`Remove ${describe(s)}`} onClick={() => setSources(sources.filter((_, j) => j !== i))}>
                      <Icon name="close" />
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="k-card k-quiet wr-add" aria-labelledby="sources-add">
            <span className="k-lbl" id="sources-add">
              Add a source
            </span>
            <Seg label="Kind of source" options={KIND_OPTIONS} value={kind} onChange={setKind} tone="text" />
            {kind === 'text' && (
              <>
                <textarea className="k-input wr-add-text" aria-label="Your text" placeholder="Notes, a draft, your opinion: Markdown" value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
                <input className="k-input" aria-label="What it is (optional)" placeholder="What it is (optional)" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} maxLength={200} />
              </>
            )}
            {kind === 'url' && <input className="k-input" type="url" aria-label="The page’s address" placeholder="https://" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />}
            {kind === 'repo' && (
              <>
                <PickerCombobox label={<span className="visually-hidden">Repository</span>} placeholder="Type a repo’s name" empty="No repo of yours matches." options={repoOptions} value={draft.repo || null} onValueChange={(name) => setDraft({ ...draft, repo: name ?? '' })} />
                <input className="k-input k-mono" aria-label="Release, branch or tag (optional)" placeholder="Release, branch or tag (optional)" value={draft.ref} onChange={(e) => setDraft({ ...draft, ref: e.target.value })} maxLength={140} />
              </>
            )}
            {kind === 'media' && (
              <>
                <label className="k-input wr-file">
                  <input type="file" className="visually-hidden" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                  <Icon name="image" />
                  <span className={`k-grow k-ellipsis${file ? '' : ' k-placeholder'}`}>{file ? file.name : 'Choose an image'}</span>
                </label>
                <input className="k-input" aria-label="What it shows (alt text)" placeholder="What it shows (alt text)" value={draft.alt} onChange={(e) => setDraft({ ...draft, alt: e.target.value })} maxLength={500} />
              </>
            )}
            <span className="k-help">{KINDS[kind].help}</span>
            <button type="button" className="k-btn k-sm wr-add-button" onClick={() => void add()} disabled={busy !== null}>
              <Icon name="plus" size={16} />
              Add
            </button>
          </section>

          <div className="k-stack k-g8">
            <span className="k-lbl">
              Also on <span className="wr-normal">· besides the blog</span>
            </span>
            <ChannelChips ready={ready} chosen={channels} onChange={setChannels} />
            <span className="k-help">
              {primary ? (
                'With a repo, its launch.yml chooses the channels instead.'
              ) : ready.length === 0 ? (
                <>
                  No channel has a connected account; connect one in <Link to="/channels">Channels</Link>.
                </>
              ) : (
                'With a repo, its launch.yml chooses the channels instead.'
              )}
            </span>
          </div>
          {busy && (
            <p className="k-sm k-muted wr-flush" role="status">
              {busy}
            </p>
          )}
        </form>
        <ActionBar>
          <button className="k-btn k-pri k-full" type="submit" form="sources-form" disabled={sources.length === 0 || !title.trim() || busy !== null} title="The drafts wait in Shipcast until you approve them.">
            Draft the launch
          </button>
        </ActionBar>
      </div>
    </>
  );
}
