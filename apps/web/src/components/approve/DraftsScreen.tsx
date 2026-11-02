import { Link, useRouter } from '@tanstack/react-router';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { launchName } from '../../server/launch-list';
import { saveDraft } from '../../server/launches.functions';
import { CHANNEL_NAMES } from '../../server/view';
import { channelOfDraft } from '../assistant/protocol';
import { useAssistant, type Assistant } from '../assistant/session';
import { TopBar } from '../kit/Bars';
import { Icon } from '../kit/Icon';
import { useToast } from '../Toasts';
import { AssistedEditor } from '../assistant/AssistedEditor';
import { launchImageSrc } from '../editor/images';
import { useMissingImages } from '../editor/missing-images';
import { renderMarkdown } from '../editor/visual';
import { ChatPanel } from '../assistant/ChatPanel';
import { checkSummary, draftProfile, draftsView, joinDraft, langName, langOf, langsOf, measure, piecesOf, splitDraft, VERDICT_WORDS, verdictCounts, words, plainText, type Piece, type Verdict } from './model';
import { Glyph, type DraftView, type LaunchData } from './parts';
import type { Language } from '@shipcast/schema/languages';

/*
 * The drafts editor (boards DraftEditor, DesktopDraftEditor and CodeCheck). The text edited is the
 * draft's body: an article's front matter and a channel draft's heading and mode line are the file's
 * and go back around it on a save. Unsaved edits survive moving between pieces.
 */

export interface EditSearch {
  draft?: string;
  lang?: Language;
  check?: true;
}

const nameOf = (channel: string) => CHANNEL_NAMES[channel] ?? channel;

interface CheckResult {
  /** The text the check read: a later edit makes it the last check, not the current one */
  text: string;
  findings: Array<{ claim: string; verdict: Verdict; evidence: string }>;
}

export function DraftsScreen({ data, search, onSearch }: { data: LaunchData; search: EditSearch; onSearch: (next: EditSearch) => void }) {
  const { launch, review } = data;
  const reviewOk = review && !('error' in review) ? review : undefined;
  const texts = useMemo(() => reviewOk?.drafts.filter((d) => d.kind === 'article' || d.kind === 'channel') ?? [], [reviewOk]);
  const pieces = useMemo(() => piecesOf(texts, channelOfDraft, nameOf), [texts]);
  // An article's images are the launch's own files, served by the app: the site's paths it links are not the app's
  const imageSrc = useMemo(() => launchImageSrc(reviewOk?.drafts ?? []), [reviewOk]);
  const piece = pieces.find((p) => p.id === search.draft) ?? pieces[0];
  const draft = piece ? (piece.drafts.find((d) => langOf(d.path) === search.lang) ?? piece.drafts[0]) : undefined;
  // A launch Shipcast holds is edited while drafted (docs/app-review.md); one in a pull request while it is open.
  // After that the screen only reads the text as it went out, titled by the launch's state
  const { editable, title } = draftsView(reviewOk, launch.state);
  const waiting = launch.status === 'drafted' && editable;
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<Record<string, CheckResult>>({});
  const project = launchName(launch);
  const params = { id: String(launch.id) };

  if (!piece || !draft) {
    return (
      <div className="ap-screen">
        <div className="k-phone">
          <TopBar back={{ label: project, to: `/launches/${launch.id}` }} />
        </div>
        <div className="k-px ap-head k-stack k-g12 ap-empty">
          <h1 className="k-d k-d48">{title}</h1>
          {review && 'error' in review && <div className="k-notice k-bad">The drafts could not be read: {review.error}</div>}
          <div className="k-card k-quiet">
            <strong>No drafts to edit</strong>
            <span className="k-sm k-muted">This launch has no text drafts to edit.</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <PieceEditor
      key={draft.path}
      launch={launch}
      params={params}
      project={project}
      pieces={pieces}
      pieceId={piece.id}
      draft={draft}
      langs={langsOf(piece.drafts)}
      languages={data.languages}
      editable={editable}
      title={title}
      waiting={waiting}
      body={bodies[draft.path]}
      setBody={(text) => setBodies((b) => ({ ...b, [draft.path]: text }))}
      check={checks[draft.path]}
      setCheck={(c) => setChecks((all) => ({ ...all, [draft.path]: c }))}
      search={search}
      onSearch={onSearch}
      imageSrc={imageSrc}
    />
  );
}

interface PieceEditorProps {
  launch: LaunchData['launch'];
  params: { id: string };
  project: string;
  pieces: Piece<DraftView>[];
  pieceId: string;
  draft: DraftView;
  langs: Language[];
  /** The brand's languages, what the assistant translates between; unknown when brand.yml could not be read */
  languages: readonly Language[] | undefined;
  editable: boolean;
  /** Drafts while editable, else the launch's state */
  title: string;
  waiting: boolean;
  body: string | undefined;
  setBody: (text: string) => void;
  check: CheckResult | undefined;
  setCheck: (check: CheckResult) => void;
  search: EditSearch;
  onSearch: (next: EditSearch) => void;
  /** Where the page shows an image the text links */
  imageSrc: (src: string) => string;
}

function PieceEditor({ launch, params, project, pieces, pieceId, draft, langs, languages, editable, title, waiting, body, setBody, check, setCheck, search, onSearch, imageSrc }: PieceEditorProps) {
  const router = useRouter();
  const toast = useToast();
  const parts = useMemo(() => splitDraft(draft.content ?? '', draft.kind), [draft.content, draft.kind]);
  const value = body ?? parts.body;
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  // From 960 px the chat sits beside the text until it is closed; then the editor offers it again
  const [deskChat, setDeskChat] = useState(true);
  const channel = draft.kind === 'article' ? 'blog' : (channelOfDraft(draft.path) ?? pieceId);
  // What the piece's network shows: its toolbar, its paste and the assistant's rule (docs/decisions/rich-editor.md)
  const profile = draftProfile(channel);
  const lang = langOf(draft.path);
  const article = launch.ref.startsWith('article:');
  const assistant = useAssistant({
    value,
    onChange: (next) => {
      setBody(next);
      setSaved(false);
    },
    launchId: launch.id,
    draftPath: draft.path,
    draftLabel: draft.label,
    ...(lang && { lang }),
    ...(languages && { languages }),
    ...(draft.kind !== 'article' && { channel }),
    ...(article && { checkDisabled: 'This launch is an article you wrote: there is no code to check it against, the article is the truth.' }),
  });
  const changed = value !== parts.body;
  const pieceName = pieces.find((p) => p.id === pieceId)?.name ?? draft.label;
  const label = draft.kind === 'article' ? `Article · ${langName(lang) || 'the text'}` : `${nameOf(channel)} post`;
  const m = draft.kind === 'article' ? undefined : measure(channel, value);
  const count = m ? `${m.length.toLocaleString('en')} / ${m.max.toLocaleString('en')}` : `${words(plainText(value)).toLocaleString('en')} words`;
  const over = m ? m.length > m.max : false;

  // The check's answer is the proposal with findings: kept as this text's last check once it is in
  const p = assistant.proposal;
  useEffect(() => {
    if (p?.findings && !p.streaming && !p.problem) setCheck({ text: p.original, findings: p.findings });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p?.findings, p?.streaming, p?.problem]);
  const checking = Boolean(p && p.label === 'Check against the code' && p.streaming);
  const checkProblem = p && p.label === 'Check against the code' ? p.problem : undefined;

  // Opening the check runs it when the text has none yet
  useEffect(() => {
    if (search.check && editable && !article && !checking && (!check || check.text !== value) && !checkProblem) assistant.run('check');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.check]);

  const save = async () => {
    setBusy(true);
    const answer = await saveDraft({ data: { id: launch.id, path: draft.path, content: joinDraft(parts, value) } }).catch((error: unknown) => ({ ok: false as const, problem: error instanceof Error ? error.message : String(error) }));
    setBusy(false);
    if (answer.ok) {
      setSaved(true);
      toast.done(`${pieceName} saved`, reviewHeld(launch) ? 'Saved as a new version: it goes out once it is approved.' : 'The edit is a commit on the pull request: it is what gets published.');
      await router.invalidate();
    } else toast.fail(answer.problem);
  };
  const status = saved && !changed ? `✓ ${pieceName} saved` : changed ? 'Not saved yet' : 'No changes';
  const pick = (id: string) => onSearch({ draft: id });
  const openCheck = () => onSearch({ draft: pieceId, ...(lang && langs.length > 1 && { lang }), check: true });
  const backToDraft = () => onSearch({ draft: pieceId, ...(lang && langs.length > 1 && { lang }) });

  // Read-only, the title is the launch's state already
  const pill = waiting ? <span className="k-pill k-p-wait">Waiting for you</span> : editable ? <span className="k-pill k-p-line">{launch.state.label}</span> : null;

  const langSeg = langs.length > 1 && (
    <span className="k-seg ap-lang" role="group" aria-label="Language">
      {langs.map((l) => (
        <button key={l} type="button" className={l === lang ? 'k-on' : undefined} aria-pressed={l === lang} aria-label={langName(l)} onClick={() => onSearch({ draft: pieceId, lang: l })}>
          {l.toUpperCase()}
        </button>
      ))}
    </span>
  );
  // The writing assistant's own editor (section write): label, Assist, the proposal over the text;
  // once the launch has gone out the text is only read, formatted as its channel shows it
  const editor = (where: 'phone' | 'desk', help: ReactNode) =>
    editable ? (
      <AssistedEditor id={`ap-draft-${where}`} label={label} assistant={assistant} help={help} className="ap-assisted" profile={profile} imageSrc={imageSrc} {...(where === 'phone' ? { onOpenChat: () => setChatOpen(true) } : !deskChat ? { onOpenChat: () => setDeskChat(true) } : {})} />
    ) : (
      <ReadOnlyText id={`ap-draft-${where}`} label={label} value={value} plain={profile.format === 'plain'} lang={lang} help={help} imageSrc={imageSrc} />
    );
  // Read-only: what went out is changed piece by piece, from the launch page's Channels tab
  const readOnlyNote = (
    <p className="k-sm k-muted ap-m0 ap-readonly-note">
      This launch is no longer waiting, so its text is only read here. Published pieces are edited one by one from{' '}
      <Link to="/launches/$id" params={params} search={{ tab: 'channels' }}>
        the launch page
      </Link>
      .
    </p>
  );
  const countLine = (where: string) => (
    <span id={`ap-count-${where}`} className={`k-mono${over ? ' ap-bad-text' : ''}`}>
      {count}
    </span>
  );
  const checkCard = editable && !article && (
    <button type="button" className="k-card k-flat ap-check-card" onClick={openCheck}>
      <span className="k-grow k-sm ap-left">
        <strong>Check against the code</strong>
        <br />
        <span className="k-muted k-xs">{check ? (check.text === value ? checkSummary(check.findings) : `${checkSummary(check.findings)} (the text changed since)`) : 'Each claim of the text, against the repo’s code'}</span>
      </span>
      <Icon name="chevronRight" size={18} />
    </button>
  );
  // One chat: beside the text from 960 px, a sheet opened from Assist's "Open the chat" on a phone
  const chat = editable && <ChatPanel assistant={assistant} open={deskChat} onOpenChange={setDeskChat} sheetOpen={chatOpen} onSheetOpenChange={setChatOpen} about={`${pieceName} draft`} />;

  if (search.check && editable) {
    return (
      <div className="ap-screen">
        <div className="k-phone">
          <TopBar back={{ label: project, to: `/launches/${launch.id}/edit`, search: { draft: pieceId } }} />
        </div>
        <div className="k-desktop">
          <div className="k-page ap-check-desk ap-crumb-page">
            <button type="button" className="k-hrow k-g4 k-sm ap-crumb ap-link-plain" onClick={backToDraft}>
              <Icon name="chevronLeft" size={16} />
              {pieceName} draft
            </button>
          </div>
        </div>
        <div className="ap-check-body">
          <CheckView launch={launch} name={pieceName} assistant={assistant} check={check} value={value} checking={checking} problem={checkProblem} onBack={backToDraft} onRetry={() => assistant.run('check')} />
        </div>
        {chat}
      </div>
    );
  }

  return (
    <div className="ap-screen">
      {/* ---------- Phone (board DraftEditor) ---------- */}
      <div className="k-phone">
        <TopBar back={{ label: project, to: `/launches/${launch.id}`, search: { tab: 'content' } }} />
        <div className="k-px k-stack k-g12 ap-head">
          <div className="k-hrow k-between">
            <h1 className="k-d k-d48">{title}</h1>
            {pill}
          </div>
          <div className="k-chips" role="tablist" aria-label="Drafts">
            {pieces.map((x) => (
              <button key={x.id} type="button" role="tab" aria-selected={x.id === pieceId} className={`k-chip${x.id === pieceId ? ' ap-chip-on' : ''}`} onClick={() => pick(x.id)}>
                {x.name}
              </button>
            ))}
          </div>
          {langSeg}
          {editor(
            'phone',
            <span className="k-hrow k-between ap-help-row">
              <span>{editable ? 'The edit is what gets published.' : 'As it went out.'}</span>
              {countLine('phone')}
            </span>,
          )}
          {checkCard}
          {!editable && readOnlyNote}
        </div>
        {editable && (
          <>
            <div className="ap-save-space" aria-hidden="true" />
            <div className="k-bar ap-save">
              <span className="k-sm k-muted k-grow" role="status">
                {status}
              </span>
              <button type="button" className="k-btn k-pri" disabled={busy || !changed} onClick={save}>
                {busy ? 'Saving…' : 'Save this edit'}
              </button>
            </div>
          </>
        )}
      </div>

      {/* ---------- Desktop (board DesktopDraftEditor) ---------- */}
      <div className="k-desktop">
        <div className="k-page">
          <Link to="/launches/$id" params={params} search={{ tab: 'content' }} className="k-hrow k-g4 k-sm ap-crumb">
            <Icon name="chevronLeft" size={16} />
            {project}
          </Link>
          <div className={`ap-ddrafts${editable ? '' : ' ap-ddrafts-read'}`}>
            <nav className="k-stack k-g4" aria-label={editable ? 'Drafts' : 'Pieces'}>
              <h1 className="k-d k-d48 ap-dh1">{title}</h1>
              {pieces.map((x) => (
                <button key={x.id} type="button" className={`k-mi${x.id === pieceId ? ' k-on' : ''}`} aria-current={x.id === pieceId ? 'true' : undefined} onClick={() => pick(x.id)}>
                  <Glyph name={x.id} size={18} />
                  {x.name}
                </button>
              ))}
            </nav>
            <div className="k-stack k-g12">
              {langSeg}
              {editor('desk', null)}
              {editable ? (
                <div className="k-hrow k-between">
                  <span className="k-xs k-muted">
                    {changed ? 'Not saved yet' : saved ? `✓ ${pieceName} saved` : 'The edit is what gets published'} · {countLine('desk')}
                  </span>
                  <button type="button" className="k-btn k-pri" disabled={busy || !changed} onClick={save}>
                    {busy ? 'Saving…' : 'Save this edit'}
                  </button>
                </div>
              ) : (
                <>
                  <span className="k-xs k-muted">As it went out · {countLine('desk')}</span>
                  {readOnlyNote}
                </>
              )}
              {checkCard}
            </div>
            {chat}
          </div>
        </div>
      </div>
    </div>
  );
}

const reviewHeld = (launch: LaunchData['launch']) => !launch.pullRequest;

/**
 * A text that is no longer edited, shown as its channel shows it: formatted for a channel that takes
 * Markdown, its own lines for a plain network. A region the keyboard can reach and scroll, never a box
 * that looks editable.
 */
function ReadOnlyText({ id, label, value, plain, lang, help, imageSrc }: { id: string; label: string; value: string; plain: boolean; lang: string | undefined; help: ReactNode; imageSrc: ((src: string) => string) | undefined }) {
  const html = useMemo(() => (plain ? '' : renderMarkdown(value, imageSrc ? { imageSrc } : {})), [plain, value, imageSrc]);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  useMissingImages(box);
  return (
    <div className="k-field">
      <span className="k-lbl" id={`${id}-label`}>
        {label}
      </span>
      {plain ? (
        <div id={id} className="k-input ap-readonly ap-readonly-plain" role="region" aria-labelledby={`${id}-label`} tabIndex={0} lang={lang}>
          {value}
        </div>
      ) : (
        <div ref={setBox} id={id} className="k-input ap-readonly ed-prose" role="region" aria-labelledby={`${id}-label`} tabIndex={0} lang={lang} dangerouslySetInnerHTML={{ __html: html }} />
      )}
      {help && <span className="k-help">{help}</span>}
    </div>
  );
}

const DOT: Record<Verdict, string> = { backed: 'k-dot-pub', planned: 'k-dot-quiet', 'not-found': 'k-dot-quiet', contradicted: 'k-dot-fail' };
const PILL: Record<Verdict, string> = { backed: 'k-p-pub', planned: 'k-p-quiet', 'not-found': 'k-p-quiet', contradicted: 'k-p-fail' };

/** Each claim of a draft against the repo's code (board CodeCheck) */
function CheckView({
  launch,
  name,
  check,
  value,
  checking,
  problem,
  onBack,
  onRetry,
}: {
  launch: LaunchData['launch'];
  name: string;
  assistant: Assistant;
  check: CheckResult | undefined;
  value: string;
  checking: boolean;
  problem: string | undefined;
  onBack: () => void;
  onRetry: () => void;
}) {
  const stale = check && check.text !== value;
  return (
    <>
      <div className="k-px k-stack k-g8 ap-head">
        <h1 className="k-d k-d30">Checked against the code</h1>
        <p className="k-sm k-muted ap-m0">
          Each claim of the {name} draft, against {launch.repo} at {launch.ref}. The code is the source of truth, not the README.
        </p>
      </div>
      {checking && (
        <div className="k-px ap-mt14">
          <div className="k-notice k-wait ap-check-wait" role="status">
            <span className="k-pill k-p-run">Checking</span>
            <span>Reading the code for each claim; the answer arrives all at once.</span>
          </div>
        </div>
      )}
      {problem && !checking && (
        <div className="k-px ap-mt14 k-stack k-g10">
          <div className="k-notice k-bad" role="alert">
            <span className="ap-diamond" aria-hidden="true" />
            <div className="k-grow">
              <strong>The check did not finish.</strong> {problem}
            </div>
          </div>
          <button type="button" className="k-btn k-sm" onClick={onRetry}>
            <Icon name="retry" size={18} />
            Check again
          </button>
        </div>
      )}
      {check && !checking && (
        <>
          {stale && (
            <div className="k-px ap-mt12">
              <div className="k-notice k-wait">
                <div className="k-grow">
                  The text changed since this check.{' '}
                  <button type="button" className="ap-link" onClick={onRetry}>
                    Check it again
                  </button>
                </div>
              </div>
            </div>
          )}
          <div className="k-px k-hrow k-g8 k-wrap ap-mt12">
            {verdictCounts(check.findings).map((c) => (
              <span key={c.verdict} className={`k-pill ${PILL[c.verdict]}`}>
                {c.words}
              </span>
            ))}
          </div>
          <div className="k-px k-stack ap-mt6">
            {check.findings.length === 0 && <p className="k-sm k-muted">The text makes no claim the code could back or contradict.</p>}
            {check.findings.map((f, i) => (
              <div key={i} className="k-row ap-finding">
                <span className="ap-verdict-dot">
                  <span className={`k-dot ${DOT[f.verdict]}`} />
                </span>
                <div className="k-grow k-stack k-g4">
                  <span className={`k-sm ap-strong7 ap-v-${f.verdict}`}>{VERDICT_WORDS[f.verdict].title}</span>
                  <span className="k-sm">“{f.claim}”</span>
                  <span className="k-xs k-muted">{f.evidence}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="k-px k-hrow k-g10 ap-mt14">
        <button type="button" className="k-btn k-full" onClick={onBack}>
          <Icon name="chevronLeft" size={18} />
          Back to the draft
        </button>
      </div>
      <div className="ap-save-space" aria-hidden="true" />
    </>
  );
}
