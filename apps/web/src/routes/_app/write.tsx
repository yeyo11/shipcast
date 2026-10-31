import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AssistedEditor } from '../../components/assistant/AssistedEditor';
import { ChatPanel } from '../../components/assistant/ChatPanel';
import { useAssistant } from '../../components/assistant/session';
import { TopBar } from '../../components/kit/Bars';
import { Icon } from '../../components/kit/Icon';
import { useToast } from '../../components/Toasts';
import { ActionBar, ChannelChips, LANGS, RadioRow, Seg } from '../../components/write/Form';
import { ago, count, words } from '../../components/write/format';
import { getChannels } from '../../server/channels.functions';
import { writeArticle } from '../../server/launches.functions';
import { CHANNEL_NAMES } from '../../server/view';

export const Route = createFileRoute('/_app/write')({
  head: () => ({ meta: [{ title: 'Write · Shipcast' }] }),
  loader: async () => {
    const data = await getChannels();
    // The channels an article can go to: those with a connected account or credentials
    const ready = data.networks.filter((n) => n.channel && n.channel !== 'blog' && (n.accounts.some((a) => a.status === 'ok') || n.usesEnv)).map((n) => n.channel!);
    return { ready };
  },
  component: Write,
});

/*
 * The article being written is kept in this browser as it is typed, so a closed tab or a reload does
 * not lose it ("Draft kept 1 min ago"). It is the writer's own convenience, on this device only; the
 * article reaches Shipcast when the pieces are prepared, and the kept draft goes then.
 */
const DRAFT_KEY = 'shipcast:write-draft';

interface Kept {
  title: string;
  markdown: string;
  lang: 'en' | 'es';
  channels: string[];
  direct: boolean;
  savedAt: number;
}

function readKept(): Kept | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const kept = JSON.parse(raw) as Partial<Kept>;
    if (typeof kept.title !== 'string' || typeof kept.markdown !== 'string' || typeof kept.savedAt !== 'number') return null;
    return {
      title: kept.title,
      markdown: kept.markdown,
      lang: kept.lang === 'en' ? 'en' : 'es',
      channels: Array.isArray(kept.channels) ? kept.channels.filter((c): c is string => typeof c === 'string') : [],
      direct: kept.direct === true,
      savedAt: kept.savedAt,
    };
  } catch {
    return null;
  }
}

function writeKept(kept: Kept | null): void {
  try {
    if (kept) window.localStorage.setItem(DRAFT_KEY, JSON.stringify(kept));
    else window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Storage blocked (a private window): the draft just is not kept
  }
}

/** Re-renders now and then, so "kept 1 min ago" keeps up with the clock */
function useTick(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

function Write() {
  const { ready } = Route.useLoaderData();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [lang, setLang] = useState<'en' | 'es'>('es');
  const [channels, setChannels] = useState<string[]>(ready);
  const [direct, setDirect] = useState(false);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [outOpen, setOutOpen] = useState(false);
  // The chat: beside the text from 960 px, a sheet on a phone; both opened from "Open the chat"
  const [chatOpen, setChatOpen] = useState(false);
  const [chatSheet, setChatSheet] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [restored, setRestored] = useState(false);
  const now = useTick(30_000);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  // The title's box grows to its lines, again when the window's width changes them
  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    const fit = () => {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [title]);
  const assistant = useAssistant({
    value: markdown,
    onChange: setMarkdown,
    lang,
    draftLabel: title.trim() || 'Article on Write',
    checkDisabled: 'An article of your own has no code behind it: it is the truth the pieces follow.',
  });

  // The kept draft comes back after the first paint, so the server's page and the browser's agree
  useEffect(() => {
    const kept = readKept();
    if (kept) {
      setTitle(kept.title);
      setMarkdown(kept.markdown);
      setLang(kept.lang);
      setChannels(kept.channels.filter((c): c is (typeof ready)[number] => (ready as readonly string[]).includes(c)));
      setDirect(kept.direct);
      setSavedAt(kept.savedAt);
    }
    setRestored(true);
    // Once, on arrival: a loader reading the channels again must not overwrite what is being typed
  }, []);

  useEffect(() => {
    if (!restored) return;
    if (!title.trim() && !markdown.trim()) {
      writeKept(null);
      setSavedAt(null);
      return;
    }
    // A pause in the typing, not every key
    const timer = window.setTimeout(() => {
      const at = Date.now();
      writeKept({ title, markdown, lang, channels, direct, savedAt: at });
      setSavedAt(at);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [restored, title, markdown, lang, channels, direct]);

  const langName = LANGS.find((l) => l.value === lang)?.label ?? lang;
  const summary = `In ${langName} · ${['Blog', ...channels.map((c) => CHANNEL_NAMES[c] ?? c)].join(', ')} · ${direct ? 'publish without review' : 'review first'}`;
  const length = count(words(markdown), 'word');
  const kept = savedAt !== null && <span className="k-xs k-muted wr-kept">Draft kept {ago(savedAt, Math.max(now, savedAt))}</span>;
  const reviewing = assistant.proposal !== null;

  return (
    <>
      <TopBar />
      <div className={`wr-page wr-write${reviewing ? ' wr-reviewing' : ''}`}>
        <div className="k-hrow k-between wr-write-head">
          <h1 className="k-d k-d48 wr-write-title">Write</h1>
          {kept}
        </div>
        <p className="k-muted k-sm wr-write-sub">An article of your own, in your words. Shipcast translates it, writes a piece for each channel and publishes it on the blog.</p>
        <div className="wr-write-grid">
          <form
            id="write-form"
            className="k-stack k-g12 wr-write-main"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              const answer = await writeArticle({ data: { title, markdown, lang, channels, direct } }).catch((error: unknown) => ({ ok: false as const, problem: error instanceof Error ? error.message : String(error) }));
              setBusy(false);
              if (answer.ok) {
                writeKept(null);
                toast.done(direct ? 'Publishing your article' : 'Preparing the pieces', 'Shipcast translates it and writes each channel’s piece; it shows on Launches while it runs.');
                await navigate({ to: '/' });
              } else toast.fail(answer.problem);
            }}
          >
            <div className="k-field wr-title-field">
              <label className="k-lbl wr-title-label" htmlFor="title">
                Title
              </label>
              <textarea
                id="title"
                ref={titleRef}
                rows={1}
                className="k-input wr-title-input"
                value={title}
                // One line of text that wraps as the board's title does: a line break would end up in the heading
                onChange={(e) => setTitle(e.target.value.replace(/\s*\n\s*/g, ' '))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.preventDefault();
                }}
                required
                maxLength={200}
              />
            </div>
            <AssistedEditor
              id="body"
              label="Article"
              assistant={assistant}
              tall
              required
              placeholder="Markdown, without the title as a heading"
              help={`Markdown, without the title as a heading · ${length}`}
              meta={`Markdown · ${length}`}
              className="wr-write-editor"
              onOpenChat={() => {
                setChatOpen(true);
                setChatSheet(true);
              }}
            />
          </form>
          <div className={`wr-write-side${chatOpen ? ' wr-chat-open' : ''}`}>
            <ChatPanel assistant={assistant} open={chatOpen} onOpenChange={setChatOpen} sheetOpen={chatSheet} onSheetOpenChange={setChatSheet} about="An article on Write" />
            <section className="k-card wr-out" aria-labelledby="write-out">
              <button type="button" className="k-hrow k-g10 wr-out-toggle" aria-expanded={outOpen} aria-controls="write-out-body" onClick={() => setOutOpen(!outOpen)}>
                <span className="k-grow k-stack">
                  <strong>How it goes out</strong>
                  <span className="k-xs k-muted">{summary}</span>
                </span>
                <span className="k-sm wr-strong">{outOpen ? 'Hide' : 'Change'}</span>
              </button>
              <h2 className="k-d k-d30 wr-out-heading" id="write-out">
                How it goes out
              </h2>
              <div id="write-out-body" className="k-stack k-g16 wr-out-body" data-open={outOpen}>
                <div className="k-stack k-g8">
                  <span className="k-lbl">Written in</span>
                  <Seg label="Written in" options={LANGS} value={lang} onChange={setLang} />
                </div>
                <div className="k-stack k-g8">
                  <span className="k-lbl">Also on</span>
                  <ChannelChips ready={ready} chosen={channels} onChange={setChannels} />
                  <span className="k-help wr-out-help">
                    Channels without a connected account are not listed; connect them in <Link to="/channels">Channels</Link>.
                  </span>
                </div>
                <fieldset className="k-stack k-g8 wr-fieldset">
                  <legend className="k-lbl wr-legend">How it is published</legend>
                  <RadioRow name="mode" checked={!direct} onChange={() => setDirect(false)}>
                    Review the pieces first
                  </RadioRow>
                  <RadioRow name="mode" checked={direct} onChange={() => setDirect(true)}>
                    Publish without review
                  </RadioRow>
                </fieldset>
              </div>
            </section>
            <ActionBar className="wr-write-bar">
              <button className="k-btn k-pri k-full" type="submit" form="write-form" disabled={busy}>
                <Icon name="send" size={18} />
                {busy ? 'Starting…' : direct ? 'Publish the article' : 'Prepare the pieces'}
              </button>
            </ActionBar>
            <p className="k-xs k-muted wr-flush wr-write-note">Shipcast translates it and writes each channel’s piece; it shows on Launches while it runs.</p>
          </div>
        </div>
      </div>
    </>
  );
}
