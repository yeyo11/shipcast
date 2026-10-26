import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { AssistedEditor } from '../../components/assistant/AssistedEditor';
import { ChatPanel } from '../../components/assistant/ChatPanel';
import { useAssistant } from '../../components/assistant/session';
import { Typewriter } from '../../components/illustrations';
import { PageHead } from '../../components/PageHead';
import { PageToolbar, ToolbarAction } from '../../components/PageToolbar';
import { SendIcon } from '../../components/ui/icons';
import { useToast } from '../../components/Toasts';
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
  const [chatOpen, setChatOpen] = useState(true);
  const assistant = useAssistant({
    value: markdown,
    onChange: setMarkdown,
    lang,
    draftLabel: title.trim() || 'Article on Write',
    checkDisabled: 'An article of your own has no code behind it: it is the truth the pieces follow.',
  });
  return (
    <>
      <PageHead title="Write" art={<Typewriter width={200} />}>An article of your own, in your words. Shipcast translates it, writes a piece for each channel you choose and publishes it on the blog.</PageHead>
      {/* The submit sits in the bar, always in view while the article grows; `form` ties it to the form below */}
      <PageToolbar
        label="Write"
        actions={<ToolbarAction primary type="submit" form="write-form" label={direct ? 'Publish the article' : 'Prepare the pieces'} busyLabel={busy && 'Starting…'} icon={<SendIcon />} disabled={busy} />}
      />
      <div className={`writer${chatOpen ? ' with-chat' : ''}`}>
      <form
        id="write-form"
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const answer = await writeArticle({ data: { title, markdown, lang, channels, direct } }).catch((error: unknown) => ({ ok: false as const, problem: error instanceof Error ? error.message : String(error) }));
          setBusy(false);
          if (answer.ok) {
            toast.done(direct ? 'Publishing your article' : 'Preparing the pieces', 'Shipcast translates it and writes each channel’s piece; it shows on Launches while it runs.');
            await navigate({ to: '/' });
          } else toast.fail(answer.problem);
        }}
      >
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
        <div className="field">
          <label htmlFor="title">Title</label>
          <input id="title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        </div>
        <AssistedEditor
          id="body"
          label="Article"
          assistant={assistant}
          tall
          required
          placeholder="Markdown, without the title as a heading"
          help="Published as you wrote it. The other language is a faithful translation you review before it goes out."
        />
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label">Also on</legend>
          <div className="checks">
            {ready.map((c) => (
              <label className="check" key={c}>
                <input
                  type="checkbox"
                  checked={channels.includes(c)}
                  onChange={(e) => setChannels(e.target.checked ? [...channels, c] : channels.filter((x) => x !== c))}
                />
                {CHANNEL_NAMES[c] ?? c}
              </label>
            ))}
          </div>
          <small>Channels without a connected account are not listed; connect them in Channels.</small>
        </fieldset>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label">How it is published</legend>
          <div className="seg">
            <label>
              <input type="radio" name="mode" checked={!direct} onChange={() => setDirect(false)} />
              <span>Review the pieces first</span>
            </label>
            <label>
              <input type="radio" name="mode" checked={direct} onChange={() => setDirect(true)} />
              <span>Publish without review</span>
            </label>
          </div>
        </fieldset>
      </form>
      <ChatPanel assistant={assistant} open={chatOpen} onOpenChange={setChatOpen} />
      </div>
    </>
  );
}
