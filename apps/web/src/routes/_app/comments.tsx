import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Mailbox } from '../../components/illustrations';
import { TopBar } from '../../components/kit/Bars';
import { NetworkGlyph } from '../../components/kit/NetworkGlyph';
import { Icon } from '../../components/kit/Icon';
import { Overlay } from '../../components/kit/Overlay';
import { PickerSelect } from '../../components/kit/Picker';
import { useLiveEnabled, useLiveRoute } from '../../components/live/Live';
import { useToast } from '../../components/Toasts';
import { ago, CLASS_NAMES, COMMENT_PILLS, INBOX_TABS, inboxTab, nextCheckIn, position, readInboxSearch, type InboxSearch, type InboxTab } from '../../server/comments-inbox';
import { approveReply, checkCommentsNow, dismissReply, listComments, redraftReply, saveCommentSettings, saveReply } from '../../server/comments.functions';
import { CHANNEL_NAMES } from '../../server/view';

/*
 * The comment inbox (boards Comments, CommentReply, SendConfirm, CommentsEmpty, CommentFilters,
 * ReplySettings, DesktopComments): what waits for a reply first, each comment read and answered in
 * place. A phone shows the list or one comment (`?reply=<id>`); a desktop shows both side by side.
 * The list can run to thousands, so it is a page at a time, and every filter (tab, channel, launch,
 * post, words) is in the address and applied by the database (docs/decisions/comment-assistant.md).
 */

export const Route = createFileRoute('/_app/comments')({
  head: () => ({ meta: [{ title: 'Comments · Shipcast' }] }),
  validateSearch: (search: Record<string, unknown>): InboxSearch => readInboxSearch(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => listComments({ data: deps }),
  component: Comments,
});

type Data = Awaited<ReturnType<typeof listComments>>;
type CommentView = Data['comments'][number];
type Open = NonNullable<Data['open']>;
type Channel = keyof Data['settings']['replies'];
type Sheets = 'filters' | 'settings' | null;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const channelName = (channel: string) => CHANNEL_NAMES[channel] ?? channel;

/** The search without the open comment: the list it was opened from */
const listSearch = (search: InboxSearch): InboxSearch => {
  const { reply: _reply, ...rest } = search;
  return rest;
};

function Glyph({ channel, size }: { channel: string; size: number }) {
  return <NetworkGlyph channel={channel} size={size} />;
}

function Avatar({ author }: { author: CommentView['author'] }) {
  const letter = [...(author.displayName ?? author.handle).replace(/^[^\p{L}\p{N}]+/u, '')][0]?.toUpperCase() ?? '?';
  return <span className="k-av">{author.avatarUrl ? <img src={author.avatarUrl} alt="" loading="lazy" /> : <span className="cm-avatar-letter">{letter}</span>}</span>;
}

function StatePill({ comment }: { comment: Pick<CommentView, 'status' | 'draft'> }) {
  // Drafted with nothing to say: the AI suggests dismissing it
  const pill = comment.status === 'draft-ready' && !comment.draft ? { label: 'No reply', pill: 'k-p-quiet' } : (COMMENT_PILLS[comment.status] ?? { label: comment.status, pill: 'k-p-line' });
  return <span className={`k-pill ${pill.pill}`}>{pill.label}</span>;
}

/** The address of one comment opened in place */
const replySearch = (search: InboxSearch, id: number): InboxSearch => ({ ...listSearch(search), reply: id });

/* ---------- The list ---------- */

function Tabs({ data, search, desktop }: { data: Data; search: InboxSearch; desktop?: boolean }) {
  const current = inboxTab(search);
  const b = data.facets.buckets;
  const counts: Record<InboxTab, number> = { waiting: b.waiting, replied: b.replied, ignored: b.ignored, all: b.waiting + b.replied + b.ignored };
  return (
    <div className={desktop ? 'cm-dtabs' : 'cm-tabs'}>
      <div role="tablist" aria-label="Comments by state" className="k-tabs">
        {INBOX_TABS.map(({ tab, label }) => {
          const on = tab === current;
          const { state: _state, reply: _reply, page: _page, ...rest } = search;
          return (
            <Link key={tab} role="tab" aria-selected={on} className={`k-tab${on ? ' k-on' : ''}`} to="/comments" search={{ ...rest, ...(tab !== 'waiting' && { state: tab }) }} resetScroll={false}>
              {label}
              <span className="k-n">{counts[tab]}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function CommentCard({ comment, data, search }: { comment: CommentView; data: Data; search: InboxSearch }) {
  const now = new Date(data.now);
  const reply = comment.draft?.trim();
  return (
    <Link to="/comments" search={replySearch(search, comment.id)} className="k-card cm-card">
      <div className="k-hrow k-g10">
        <Avatar author={comment.author} />
        <div className="k-grow k-stack">
          <span className="k-sm k-ellipsis">
            <strong>{comment.author.handle}</strong>
          </span>
          <span className="k-xs k-muted k-hrow k-g6">
            <Glyph channel={comment.channel} size={13} />
            {channelName(comment.channel)} · {ago(comment.createdAt, now)}
          </span>
        </div>
        <Icon name="chevronRight" size={18} />
      </div>
      <div className="cm-text k-clamp3">{comment.text}</div>
      {reply && comment.status !== 'dismissed' && (
        <div className="k-sm cm-quote cm-clamp4">
          <span className="k-xs k-muted">{comment.status === 'sent' ? 'Your reply, sent' : 'Your reply, drafted'}</span>
          {reply}
        </div>
      )}
      <div className="k-hrow k-between k-g8 k-wrap">
        <StatePill comment={comment} />
        <span className="k-xs k-muted">on {data.launches[comment.launchId] ?? `launch ${comment.launchId}`}</span>
      </div>
    </Link>
  );
}

function Pager({ page, search }: { page: Data['page']; search: InboxSearch }) {
  if (page.pages <= 1) return null;
  const at = (n: number): InboxSearch => {
    const { page: _page, reply: _reply, ...rest } = search;
    return n > 1 ? { ...rest, page: n } : rest;
  };
  return (
    <nav className="k-hrow k-g12 cm-pager" aria-label="Pages of comments">
      {page.number > 1 ? (
        <Link className="k-btn k-sm" to="/comments" search={at(page.number - 1)}>
          Previous
        </Link>
      ) : (
        <button type="button" className="k-btn k-sm" disabled>
          Previous
        </button>
      )}
      <span className="k-xs k-muted" aria-live="polite">
        Page {page.number} of {page.pages}
      </span>
      {page.number < page.pages ? (
        <Link className="k-btn k-sm" to="/comments" search={at(page.number + 1)}>
          Next
        </Link>
      ) : (
        <button type="button" className="k-btn k-sm" disabled>
          Next
        </button>
      )}
    </nav>
  );
}

/** Under the last of what waits: that it is all, and when Shipcast reads the networks again */
function EndNote({ data, search, className }: { data: Data; search: InboxSearch; className: string }) {
  if (inboxTab(search) !== 'waiting' || data.comments.length === 0 || data.page.number < data.page.pages) return null;
  const next = data.automationOff ? 'Automation is off.' : `Next check in ${nextCheckIn(new Date(data.now))} min.`;
  return <p className={`k-xs k-muted ${className}`}>That is everything waiting. {next}</p>;
}

const filtered = (search: InboxSearch) => Boolean(search.channel || search.launch || search.post || search.q);

/** Nothing in the list: the board's empty state for what waits, a line for the rest */
function Empty({ search }: { search: InboxSearch }) {
  if (filtered(search)) return <p className="k-px k-muted cm-empty-none">No comment matches these filters.</p>;
  const tab = inboxTab(search);
  if (tab !== 'waiting') return <p className="k-px k-muted cm-empty-none">{tab === 'replied' ? 'No comment answered yet.' : tab === 'ignored' ? 'No comment dismissed.' : 'No comments yet.'}</p>;
  return (
    <div className="k-px k-stack k-g16 cm-empty">
      <div className="cm-empty-art" aria-hidden="true">
        <Mailbox width="100%" />
      </div>
      <h2 className="k-d k-d30">Nothing waits for a reply</h2>
      <p className="k-muted cm-empty-text">Shipcast reads the replies to your posts every 30 minutes and drafts an answer for each one worth answering.</p>
      <Link className="k-btn" to="/comments" search={{ state: 'replied' }}>
        See the answered ones
      </Link>
    </div>
  );
}

function useCheckNow() {
  const router = useRouter();
  const toast = useToast();
  return async () => {
    try {
      const answer = await checkCommentsNow();
      if (answer.ok) toast.done('Checking the comments', 'The drafts appear here when the job ends.');
      else toast.fail(answer.problem);
      await router.invalidate();
    } catch (error) {
      toast.fail(errorText(error));
    }
  };
}

function PhoneInbox({ data, search, openSheet }: { data: Data; search: InboxSearch; openSheet: (s: Sheets) => void }) {
  const checkNow = useCheckNow();
  const set = (search.channel ? 1 : 0) + (search.launch ? 1 : 0) + (search.post ? 1 : 0) + (search.q ? 1 : 0);
  return (
    <>
      <TopBar />
      <div className="k-px k-hrow k-between cm-head">
        <h1 className="k-d k-d48">Comments</h1>
        <div className="k-hrow k-g4 cm-head-tools">
          <button type="button" className="k-btn k-icon k-sm k-ghost" aria-label="Check comments now" onClick={() => void checkNow()}>
            <Icon name="retry" />
          </button>
          <button type="button" className="k-btn k-icon k-sm" aria-label={set > 0 ? `Filters, ${set} set` : 'Filters'} onClick={() => openSheet('filters')}>
            <Icon name="filter" />
            {set > 0 && (
              <span className="k-badge" aria-hidden="true">
                {set}
              </span>
            )}
          </button>
        </div>
      </div>
      <Tabs data={data} search={search} />
      {data.comments.length === 0 ? (
        <Empty search={search} />
      ) : (
        <div className="k-px k-stack k-g12 cm-list">
          {data.comments.map((c) => (
            <CommentCard key={c.id} comment={c} data={data} search={search} />
          ))}
        </div>
      )}
      <Pager page={data.page} search={search} />
      <EndNote data={data} search={search} className="k-px cm-foot" />
      <div className="cm-after-list" />
    </>
  );
}

/* ---------- Replying in place ---------- */

interface ReplyProps {
  open: Open;
  data: Data;
  search: InboxSearch;
  /** Sent from this view just now: the board's "Reply sent" stays in place */
  sent: boolean;
  onSent: () => void;
}

/** One comment and its reply: the editor's state and every action, shaped by the phone or the desktop view */
function useReply({ open, data, search, onSent }: ReplyProps) {
  const router = useRouter();
  const navigate = useNavigate();
  const toast = useToast();
  const { comment } = open;
  const [draft, setDraft] = useState(comment.draft ?? '');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // A new draft from the server (drafted again, or saved elsewhere) replaces what is shown
  useEffect(() => setDraft(comment.draft ?? ''), [comment.draft]);
  const limit = data.limits[comment.channel as Channel] ?? 300;
  const length = [...draft].length;
  const changed = draft !== (comment.draft ?? '');
  const editable = comment.status !== 'sent' && comment.status !== 'approved';
  const { next } = position(data.comments, comment.id, data.page.total, inboxTab(search));

  const run = async (what: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await what();
      if (done) toast.done(done);
      await router.invalidate();
    } catch (error) {
      toast.fail(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  return {
    comment,
    draft,
    setDraft,
    busy,
    limit,
    length,
    changed,
    editable,
    next,
    confirming,
    setConfirming,
    save: () => run(() => saveReply({ data: { id: comment.id, draft } }), 'Draft saved'),
    again: () => run(() => redraftReply({ data: comment.id }), 'Drafting the reply again'),
    dismiss: () =>
      run(async () => {
        await dismissReply({ data: comment.id });
        // On to the next comment, or back to the list when this was the last
        await navigate({ to: '/comments', search: next ? replySearch(search, next.id) : listSearch(search), replace: true, resetScroll: false });
      }, 'Dismissed'),
    send: () =>
      run(async () => {
        if (changed) await saveReply({ data: { id: comment.id, draft } });
        // The sheet closes whatever the answer: a refusal is told by a toast over the reply it kept
        const answer = await approveReply({ data: comment.id }).finally(() => setConfirming(false));
        if (answer.status === 'failed') toast.fail(answer.problem ?? 'The reply could not be sent');
        else if (answer.status === 'sent') onSent();
        else toast.done('Sending the reply');
      }),
  };
}

type Reply = ReturnType<typeof useReply>;

/** The post the comment answers, as quiet context above it */
function PostQuote({ open, data, clamp }: { open: Open; data: Data; clamp: boolean }) {
  const { comment, thread } = open;
  return (
    <div className="k-card k-quiet cm-post">
      <span className="k-xs k-muted k-hrow k-g6">
        <Glyph channel={comment.channel} size={13} />
        Your post on {channelName(comment.channel)} · {data.launches[comment.launchId] ?? `launch ${comment.launchId}`}
      </span>
      {thread.postText && <span className={`k-sm cm-post-text${clamp ? ' k-clamp2' : ''}`}>{thread.postText}</span>}
    </div>
  );
}

function TheComment({ open, data, desktop }: { open: Open; data: Data; desktop?: boolean }) {
  const { comment } = open;
  const classification = comment.classification ? CLASS_NAMES[comment.classification] : undefined;
  return (
    <div className={`k-hrow ${desktop ? 'k-g12' : 'k-g10'} cm-comment`}>
      <Avatar author={comment.author} />
      <div className="k-stack k-g4 k-grow">
        <span className={desktop ? undefined : 'k-sm'}>
          <strong>{comment.author.handle}</strong>{' '}
          <span className={desktop ? 'k-muted k-sm' : 'k-muted'}>
            ·{' '}
            {comment.url ? (
              <a className="cm-ago" href={comment.url} target="_blank" rel="noreferrer" title={`Open it on ${channelName(comment.channel)}`}>
                {ago(comment.createdAt, new Date(data.now))}
              </a>
            ) : (
              ago(comment.createdAt, new Date(data.now))
            )}
          </span>
        </span>
        <span className="cm-comment-text">{comment.text}</span>
        {!desktop && classification && (
          <span className="k-hrow k-g6">
            <span className="k-pill k-p-line">{classification}</span>
          </span>
        )}
      </div>
    </div>
  );
}

function ReplyField({ r }: { r: Reply }) {
  const id = useId();
  const { comment } = r;
  const empty = !comment.draft && (comment.status === 'new' || comment.status === 'draft-ready');
  return (
    <div className="k-field">
      <div className="k-hrow k-between">
        <label className="k-lbl" htmlFor={id}>
          Your reply
        </label>
        <StatePill comment={comment} />
      </div>
      <textarea
        id={id}
        className="k-input cm-editor"
        value={r.draft}
        readOnly={!r.editable}
        aria-describedby={`${id}-count`}
        placeholder={comment.status === 'new' ? 'The reply is being drafted…' : empty ? 'No reply was drafted: dismiss it, or write one.' : undefined}
        onChange={(e) => r.setDraft(e.target.value)}
      />
      <div className="k-hrow k-between k-help">
        <span id={`${id}-count`} className={r.length > r.limit ? 'cm-over' : undefined}>
          {r.length} of {r.limit} characters
        </span>
        {r.editable && (
          <button type="button" className="k-btn k-sm k-ghost cm-draft-again" disabled={r.busy} onClick={() => void r.again()}>
            <Icon name="retry" size={16} />
            Draft again
          </button>
        )}
      </div>
      {comment.note && <p className="k-help cm-sheet-text">{comment.note}</p>}
      {!comment.canReply && r.editable && <p className="k-help cm-sheet-text">{channelName(comment.channel)} cannot send a reply through its API: the reply is copied, and its page opens to paste it.</p>}
      {comment.status === 'failed' && comment.problem && (
        <div className="k-notice k-bad" role="alert">
          <span>{comment.problem}</span>
        </div>
      )}
    </div>
  );
}

function SentToast({ open }: { open: Open }) {
  const { comment, thread } = open;
  return (
    <div className="k-toast cm-sent-toast" role="status">
      <div className="k-hrow k-g8">
        <span className="k-pill k-p-pub">Done</span>
        <strong className="k-sm">Reply sent</strong>
      </div>
      <span className="k-xs k-muted">
        It is on {channelName(comment.channel)}
        {thread.account ? ` under ${thread.account}` : ''}.
        {comment.sentUrl && (
          <>
            {' '}
            <a href={comment.sentUrl} target="_blank" rel="noreferrer">
              See it
            </a>
          </>
        )}
      </span>
    </div>
  );
}

/** The actions: Dismiss, Save and the one yellow action (send, or for a network that cannot reply, copy and open it) */
function Actions({ r, sent, desktop }: { r: Reply; sent: boolean; desktop?: boolean }) {
  const { comment } = r;
  const tooLong = r.length > r.limit;
  const nothing = !r.draft.trim();
  // On a phone the yellow action fills what the bar leaves
  const pri = desktop ? 'k-btn k-pri' : 'k-btn k-pri k-grow';
  let primary: ReactNode;
  if (comment.status === 'sent' || sent) {
    primary = (
      <button type="button" className={pri} disabled>
        {desktop && <Icon name="check" size={18} />}
        Sent
      </button>
    );
  } else if (comment.status === 'approved') {
    primary = (
      <button type="button" className={pri} disabled>
        Sending…
      </button>
    );
  } else if (!comment.canReply && comment.replyOn) {
    primary = (
      <a className={pri} href={comment.replyOn} target="_blank" rel="noreferrer" onClick={() => void navigator.clipboard?.writeText(r.draft).catch(() => undefined)}>
        {desktop && <Icon name="external" size={18} />}
        Reply on {channelName(comment.channel)}
      </a>
    );
  } else {
    primary = (
      <button type="button" className={pri} disabled={r.busy || nothing || tooLong || !comment.canReply} onClick={() => r.setConfirming(true)}>
        {desktop && <Icon name="send" size={18} />}
        {comment.status === 'failed' ? 'Send again' : 'Send the reply'}
      </button>
    );
  }
  const dismiss = r.editable && comment.status !== 'dismissed' && (
    <button type="button" className={`k-btn k-ghost${desktop ? '' : ' k-sm'}`} disabled={r.busy} onClick={() => void r.dismiss()}>
      Dismiss
    </button>
  );
  const save = r.editable && (
    <button type="button" className="k-btn" disabled={r.busy || nothing || tooLong} onClick={() => void r.save()}>
      Save
    </button>
  );
  if (desktop)
    return (
      <div className="k-hrow k-g10">
        {dismiss}
        <span className="k-grow" />
        {save}
        {primary}
      </div>
    );
  return (
    <div className="k-bar cm-bar">
      {dismiss}
      {save}
      {primary}
    </div>
  );
}

/** Board SendConfirm: what goes out, where, and that it cannot be edited afterwards */
function SendSheet({ r, open }: { r: Reply; open: Open }) {
  const { comment } = open;
  return (
    <Overlay kind="dialog" label={`Send this reply to ${comment.author.handle}?`} open={r.confirming} onOpenChange={r.setConfirming} className="cm-sheet" heading={<>Send this reply to {comment.author.handle}?</>}>
      <div className="k-card cm-sheet-quote">
        <span className="k-sm">{r.draft}</span>
      </div>
      <p className="k-sm k-muted cm-sheet-text">It goes out on {channelName(comment.channel)} under your connected account, and it cannot be edited afterwards.</p>
      <div className="k-hrow k-g10 cm-sheet-actions">
        <button type="button" className="k-btn" onClick={() => r.setConfirming(false)}>
          Not yet
        </button>
        <button type="button" className="k-btn k-pri k-grow" disabled={r.busy} onClick={() => void r.send()}>
          <Icon name="send" size={18} />
          {r.busy ? 'Sending…' : 'Send the reply'}
        </button>
      </div>
    </Overlay>
  );
}

function PhoneReply(props: ReplyProps) {
  const r = useReply(props);
  const { open, data, search, sent } = props;
  const { label, next } = position(data.comments, open.comment.id, data.page.total, inboxTab(search));
  return (
    <>
      <TopBar back={{ label: 'Comments', to: '/comments', search: { ...listSearch(search) } }} />
      <div className="k-px k-stack cm-reply">
        <div className="k-hrow k-between">
          <span className="k-xs k-muted">{label ?? ''}</span>
          {next ? (
            <Link className="k-btn k-sm cm-next" to="/comments" search={replySearch(search, next.id)} replace>
              Next <Icon name="chevronRight" size={16} />
            </Link>
          ) : (
            <button type="button" className="k-btn k-sm cm-next" disabled>
              Next <Icon name="chevronRight" size={16} />
            </button>
          )}
        </div>
        <PostQuote open={open} data={data} clamp />
        <TheComment open={open} data={data} />
        <ReplyField r={r} />
        {sent && <SentToast open={open} />}
      </div>
      <div className="cm-after-reply" />
      <Actions r={r} sent={sent} />
      <SendSheet r={r} open={open} />
    </>
  );
}

/* ---------- Desktop ---------- */

function DesktopItem({ comment, data, search, on }: { comment: CommentView; data: Data; search: InboxSearch; on: boolean }) {
  return (
    <Link to="/comments" search={replySearch(search, comment.id)} replace resetScroll={false} className="k-stack k-g6 cm-item" aria-current={on ? 'true' : undefined}>
      <div className="k-hrow k-g10">
        <Avatar author={comment.author} />
        <span className="k-grow k-sm k-ellipsis">
          <strong>{comment.author.handle}</strong> <span className="k-muted">· {ago(comment.createdAt, new Date(data.now))}</span>
        </span>
        <Glyph channel={comment.channel} size={14} />
      </div>
      <span className="k-sm k-clamp2">{comment.text}</span>
      <div className="k-hrow k-between">
        <StatePill comment={comment} />
        <span className="k-xs k-muted">{data.launches[comment.launchId] ?? ''}</span>
      </div>
    </Link>
  );
}

function DesktopPanel(props: ReplyProps) {
  const r = useReply(props);
  const { open, data, sent } = props;
  return (
    <section className="k-card cm-panel" aria-label={`The comment by ${open.comment.author.handle}`}>
      <PostQuote open={open} data={data} clamp={false} />
      <TheComment open={open} data={data} desktop />
      <ReplyField r={r} />
      {sent && <SentToast open={open} />}
      <Actions r={r} sent={sent} desktop />
      <SendSheet r={r} open={open} />
    </section>
  );
}

function DesktopInbox({ data, search, openSheet, sentId, onSent }: { data: Data; search: InboxSearch; openSheet: (s: Sheets) => void; sentId: number | null; onSent: (id: number) => void }) {
  const checkNow = useCheckNow();
  const open = data.open;
  const set = (search.channel ? 1 : 0) + (search.launch ? 1 : 0) + (search.post ? 1 : 0) + (search.q ? 1 : 0);
  return (
    <div className="k-page">
      <div className="k-hrow k-between cm-dhead">
        <h1 className="k-d k-d96">Comments</h1>
        <div className="k-hrow k-g8">
          <button type="button" className="k-btn k-sm" onClick={() => void checkNow()}>
            <Icon name="retry" size={18} />
            Check now
          </button>
          <button type="button" className="k-btn k-sm" onClick={() => openSheet('filters')}>
            <Icon name="filter" size={18} />
            {set > 0 ? `Filters (${set})` : 'Filters'}
          </button>
          <button type="button" className="k-btn k-sm" onClick={() => openSheet('settings')}>
            Replies per channel
          </button>
        </div>
      </div>
      <Tabs data={data} search={search} desktop />
      {data.comments.length === 0 && !open ? (
        <Empty search={search} />
      ) : (
        <div className="cm-grid">
          <div className="k-stack k-g8">
            {data.comments.map((c) => (
              <DesktopItem key={c.id} comment={c} data={data} search={search} on={c.id === open?.comment.id} />
            ))}
            {data.comments.length === 0 && <p className="k-sm k-muted">Nothing else here.</p>}
            <Pager page={data.page} search={search} />
            <EndNote data={data} search={search} className="cm-dfoot" />
          </div>
          {open && <DesktopPanel key={open.comment.id} open={open} data={data} search={search} sent={sentId === open.comment.id} onSent={() => onSent(open.comment.id)} />}
        </div>
      )}
    </div>
  );
}

/* ---------- Filters and the reply settings ---------- */

function Select({ label, value, options, onChange, disabled }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (v: string) => void; disabled?: boolean }) {
  return <PickerSelect label={label} value={value} options={options} onValueChange={onChange} disabled={disabled} />;
}

const ALL = 'all';

/** Board CommentFilters: every change is a change of the address, which is what loads the list */
function FiltersSheet({ data, search, open, onOpenChange, openSettings }: { data: Data; search: InboxSearch; open: boolean; onOpenChange: (o: boolean) => void; openSettings: () => void }) {
  const navigate = useNavigate();
  const searchId = useId();
  const go = (patch: Partial<InboxSearch>) => {
    // Any change of filter starts again from the first page; a launch change drops its post
    const next: Record<string, unknown> = { ...listSearch(search), page: undefined, ...('launch' in patch && { post: undefined }), ...patch };
    void navigate({ to: '/comments', search: Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== '')) as InboxSearch, resetScroll: false, replace: true });
  };
  const [words, setWords] = useState(search.q ?? '');
  useEffect(() => setWords(search.q ?? ''), [search.q]);
  useEffect(() => {
    if (words.trim() === (search.q ?? '')) return;
    const timer = setTimeout(() => go({ q: words.trim() || undefined }), 400);
    return () => clearTimeout(timer);
  });
  const launches = [{ value: ALL, label: 'All launches' }, ...data.facets.launches.map((l) => ({ value: String(l.id), label: `${data.launches[l.id] ?? l.repo} (${l.count})` }))];
  const posts = [{ value: ALL, label: 'All posts' }, ...data.facets.posts.map((p) => ({ value: String(p.id), label: `${channelName(p.channel)}${p.kind === 'post' ? '' : ` · ${p.kind}`} (${p.count})` }))];
  return (
    <Overlay kind="drawer" label="Filters" open={open} onOpenChange={onOpenChange} className="cm-sheet" heading="Filters">
      <form
        role="search"
        className="k-field"
        onSubmit={(e) => {
          e.preventDefault();
          go({ q: words.trim() || undefined });
        }}
      >
        <label className="k-lbl" htmlFor={searchId}>
          Search
        </label>
        <span className="k-input">
          <input id={searchId} className="cm-search-input" type="search" placeholder="Words in the comment or its author" value={words} onChange={(e) => setWords(e.target.value)} />
          <span className="k-muted k-hrow">
            <Icon name="search" size={18} />
          </span>
        </span>
      </form>
      <div className="k-stack k-g8" role="group" aria-label="Channel">
        <span className="k-lbl">Channel</span>
        <div className="k-chips">
          <button type="button" className={`k-chip${!search.channel ? ' k-on' : ''}`} aria-pressed={!search.channel} onClick={() => go({ channel: undefined })}>
            All channels
          </button>
          {[...data.facets.channels].sort((a, b) => b.count - a.count).map((c) => (
            <button key={c.channel} type="button" className={`k-chip${search.channel === c.channel ? ' k-on' : ''}`} aria-pressed={search.channel === c.channel} onClick={() => go({ channel: c.channel })}>
              <Glyph channel={c.channel} size={15} />
              {channelName(c.channel)} ({c.count})
            </button>
          ))}
        </div>
      </div>
      <Select label="Launch" value={search.launch ? String(search.launch) : ALL} options={launches} onChange={(v) => go({ launch: v === ALL ? undefined : Number(v) })} />
      <Select label="Post" value={search.post ? String(search.post) : ALL} options={posts} onChange={(v) => go({ post: v === ALL ? undefined : Number(v) })} />
      <div className="k-hrow k-g10 cm-sheet-actions">
        <button
          type="button"
          className="k-btn"
          onClick={() => {
            setWords('');
            go({ channel: undefined, launch: undefined, post: undefined, q: undefined });
          }}
        >
          Clear
        </button>
        <button type="button" className="k-btn k-pri k-grow" onClick={() => onOpenChange(false)}>
          Show {data.page.total} {data.page.total === 1 ? 'comment' : 'comments'}
        </button>
      </div>
      <div className="k-sep" />
      <button type="button" className="k-mi cm-settings-mi" onClick={openSettings}>
        <Icon name="comments" />
        <span className="k-grow">Replies per channel</span>
        <Icon name="chevronRight" size={18} />
      </button>
    </Overlay>
  );
}

const MODES = [
  { mode: 'approval', label: 'Approval' },
  { mode: 'auto', label: 'Auto' },
  { mode: 'off', label: 'Off' },
] as const;

/** Board ReplySettings: each channel's mode, for the networks with an account connected; saved together */
function SettingsSheet({ data, open, onOpenChange }: { data: Data; open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const toast = useToast();
  const [modes, setModes] = useState<Record<string, string>>(data.settings.replies);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setModes(data.settings.replies);
  }, [open, data.settings.replies]);
  const all = Object.keys(data.settings.replies) as Channel[];
  const connected = all.filter((c) => data.networks.includes(c));
  // No account yet: every channel, so a mode can still be chosen ahead
  const canReply = (c: string) => Boolean((data.capabilities as Record<string, { reply?: boolean } | undefined>)[c]?.reply);
  // The channels that can answer first; one that can only draft (dev.to) after them, its Auto off
  const channels = (connected.length > 0 ? connected : all).sort((a, b) => Number(canReply(b)) - Number(canReply(a)));
  // A connected network with no row: it cannot answer at all
  const cannot = data.networks.filter((n) => !(channels as string[]).includes(n) && !canReply(n) && CHANNEL_NAMES[n]);
  const changes = Object.fromEntries(Object.entries(modes).filter(([c, m]) => data.settings.replies[c as Channel] !== m));
  const save = async () => {
    setBusy(true);
    try {
      if (Object.keys(changes).length > 0) {
        await saveCommentSettings({ data: { replies: changes } });
        toast.done('Replies per channel saved');
        await router.invalidate();
      }
      onOpenChange(false);
    } catch (error) {
      toast.fail(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Overlay kind="drawer" label="Replies per channel" open={open} onOpenChange={onOpenChange} className="cm-sheet" heading="Replies per channel">
      <p className="k-sm k-muted cm-sheet-text">Approval: replies are drafted and wait for you. Auto: drafted and sent at once. Off: Shipcast does not read them.</p>
      <div className="k-stack">
        {channels.map((channel) => {
          return (
            <div key={channel} className="k-row cm-mode">
              <span className="k-hrow k-g10 k-grow">
                <span className="k-ic">
                  <Glyph channel={channel} size={17} />
                </span>
                <strong>{channelName(channel)}</strong>
              </span>
              <div className="k-seg" role="radiogroup" aria-label={`${channelName(channel)}: replies`}>
                {MODES.map(({ mode, label }) => {
                  const on = modes[channel] === mode;
                  const blocked = mode === 'auto' && !canReply(channel);
                  return (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      className={on ? 'k-on' : ''}
                      disabled={blocked}
                      title={blocked ? `${channelName(channel)} cannot send a reply through its API` : undefined}
                      onClick={() => setModes((m) => ({ ...m, [channel]: mode }))}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {cannot.map((n) => (
        <div key={n} className="k-xs k-muted k-hrow k-g8">
          <Glyph channel={n} size={14} />
          {channelName(n)} cannot send a reply through its API.
        </div>
      ))}
      <button type="button" className="k-btn k-pri k-full" disabled={busy} onClick={() => void save()}>
        Save
      </button>
    </Overlay>
  );
}

/* ---------- The page ---------- */

function Comments() {
  const data = Route.useLoaderData();
  // Live: a comment read, drafted or sent, or a piece it hangs under, reloads the list
  useLiveRoute(Route.id, useLiveEnabled() ? ['comment', 'post'] : null);
  const search = Route.useSearch();
  const [sheet, setSheet] = useState<Sheets>(null);
  // The comment sent from here, so its "Reply sent" stays while the list reloads around it
  const [sentId, setSentId] = useState<number | null>(null);
  const open = data.open;
  const replying = search.reply !== undefined && open?.comment.id === search.reply;
  return (
    <>
      <div className="k-phone">
        {replying && open ? (
          <PhoneReply key={open.comment.id} open={open} data={data} search={search} sent={sentId === open.comment.id} onSent={() => setSentId(open.comment.id)} />
        ) : (
          <PhoneInbox data={data} search={search} openSheet={setSheet} />
        )}
      </div>
      <div className="k-desktop">
        <DesktopInbox data={data} search={search} openSheet={setSheet} sentId={sentId} onSent={setSentId} />
      </div>
      <FiltersSheet data={data} search={search} open={sheet === 'filters'} onOpenChange={(o) => setSheet(o ? 'filters' : null)} openSettings={() => setSheet('settings')} />
      <SettingsSheet data={data} open={sheet === 'settings'} onOpenChange={(o) => setSheet(o ? 'settings' : null)} />
    </>
  );
}
