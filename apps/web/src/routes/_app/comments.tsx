import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Mailbox } from '../../components/illustrations';
import { PageHead } from '../../components/PageHead';
import { PageToolbar, ToolbarAction } from '../../components/PageToolbar';
import { useToast } from '../../components/Toasts';
import { ChannelName, Pill, when } from '../../components/ui';
import { ConfirmButton } from '../../components/ui/ConfirmButton';
import { Drawer } from '../../components/ui/Drawer';
import { RefreshIcon } from '../../components/ui/icons';
import { Popover } from '../../components/ui/Popover';
import { usePhone } from '../../components/ui/ResponsiveMenu';
import { Select, type Option } from '../../components/ui/Select';
import { approveReply, checkCommentsNow, dismissReply, listComments, redraftReply, saveCommentSettings, saveReply } from '../../server/comments.functions';
import { COMMENT_STATE_NAMES, COMMENT_STATES, readCommentsSearch, type CommentsSearch, type CommentState } from '../../server/comments-search';
import { CHANNEL_NAMES, type Tone } from '../../server/view';

/*
 * The comment assistant's page, plain on purpose: the list, each draft with its actions, and each
 * channel's mode. The list can run to thousands, so it is a page at a time and every filter (state,
 * channel, launch, post, words) is in the address and applied by the database (docs/decisions/comment-assistant.md).
 */

export const Route = createFileRoute('/_app/comments')({
  head: () => ({ meta: [{ title: 'Comments · Shipcast' }] }),
  validateSearch: (search: Record<string, unknown>): CommentsSearch => readCommentsSearch(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => listComments({ data: deps }),
  component: Comments,
});

type Data = Awaited<ReturnType<typeof listComments>>;
type CommentView = Data['comments'][number];
type Channel = keyof Data['settings']['replies'];

const STATUS: Record<CommentView['status'], { label: string; tone: Tone }> = {
  new: { label: 'New', tone: 'waiting' },
  'draft-ready': { label: 'Draft ready', tone: 'draft' },
  approved: { label: 'Sending', tone: 'waiting' },
  sent: { label: 'Answered', tone: 'published' },
  dismissed: { label: 'Dismissed', tone: 'quiet' },
  failed: { label: 'Failed', tone: 'failed' },
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function CommentRow({ comment, limit }: { comment: CommentView; limit: number }) {
  const router = useRouter();
  const toast = useToast();
  const [draft, setDraft] = useState(comment.draft ?? '');
  const [busy, setBusy] = useState(false);
  const open = comment.status === 'new' || comment.status === 'draft-ready' || comment.status === 'failed' || comment.status === 'dismissed';
  const run = async (what: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await what();
      toast.done(done);
      await router.invalidate();
    } catch (error) {
      toast.fail(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const status = STATUS[comment.status];
  const suggestDismiss = comment.status === 'draft-ready' && !comment.draft;

  return (
    <article className="card">
      <div className="row">
        <ChannelName channel={comment.channel} />
        <strong>{comment.author.displayName ?? comment.author.handle}</strong>
        <span className="muted">
          {comment.author.handle} · {when(comment.createdAt)}
        </span>
        <Pill tone={status.tone}>{status.label}</Pill>
        {comment.classification && <span className="muted">{comment.classification}</span>}
      </div>
      <p style={{ whiteSpace: 'pre-wrap' }}>{comment.text}</p>
      {comment.url && (
        <p className="muted">
          <a href={comment.url} target="_blank" rel="noreferrer">
            Open the comment
          </a>
          {' · '}
          <a href={`/launches/${comment.launchId}`}>its launch</a>
        </p>
      )}
      {comment.note && <p className="muted">{comment.note}</p>}
      {comment.problem && <p className="muted">Problem: {comment.problem}</p>}
      {comment.status === 'sent' ? (
        <p className="muted">
          Answered {comment.sentAt ? when(comment.sentAt) : ''}
          {comment.sentUrl && (
            <>
              {' · '}
              <a href={comment.sentUrl} target="_blank" rel="noreferrer">
                the reply
              </a>
            </>
          )}
        </p>
      ) : (
        open && (
          <div className="form">
            {suggestDismiss && <p className="muted">Suggested: dismiss. No reply was drafted.</p>}
            <div className="field">
              <label htmlFor={`reply-${comment.id}`}>Reply</label>
              <textarea id={`reply-${comment.id}`} className="input" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
              <small>
                {[...draft].length} of {limit} characters.
                {!comment.canReply && ' This network cannot reply through its API: copy the reply and post it there.'}
              </small>
            </div>
            <div className="row">
              {comment.canReply ? (
                <ConfirmButton
                  className="btn btn-primary btn-small"
                  disabled={busy || !draft.trim()}
                  tone="primary"
                  title={`Send this reply to ${comment.author.handle}?`}
                  description={`It goes out on ${CHANNEL_NAMES[comment.channel] ?? comment.channel} under your connected account, and it cannot be edited afterwards.`}
                  confirm="Send the reply"
                  onConfirm={() =>
                    run(async () => {
                      if (draft !== (comment.draft ?? '')) await saveReply({ data: { id: comment.id, draft } });
                      await approveReply({ data: comment.id });
                    }, 'Reply sent')
                  }
                >
                  Approve and send
                </ConfirmButton>
              ) : (
                comment.replyOn && (
                  <a className="btn btn-small" href={comment.replyOn} target="_blank" rel="noreferrer">
                    Reply on {comment.channel === 'devto' ? 'dev.to' : comment.channel}
                  </a>
                )
              )}
              <button className="btn btn-small" type="button" disabled={busy || !draft.trim() || draft === (comment.draft ?? '')} onClick={() => void run(() => saveReply({ data: { id: comment.id, draft } }), 'Draft saved')}>
                Save the draft
              </button>
              <button className="btn btn-small" type="button" disabled={busy} onClick={() => void run(() => redraftReply({ data: comment.id }), 'Drafting again')}>
                Draft again
              </button>
              {comment.status !== 'dismissed' && (
                <button className="btn btn-small btn-danger" type="button" disabled={busy} onClick={() => void run(() => dismissReply({ data: comment.id }), 'Dismissed')}>
                  Dismiss
                </button>
              )}
            </div>
          </div>
        )
      )}
    </article>
  );
}

function Modes({ data }: { data: Data }) {
  const router = useRouter();
  const toast = useToast();
  const channels = Object.keys(data.settings.replies) as Channel[];
  return (
    <table className="table">
      <tbody>
        {channels.map((channel) => (
          <tr key={channel}>
            <th scope="row">
              <ChannelName channel={channel} />
            </th>
            <td>
              <select
                className="input"
                aria-label={`${channel}: replies`}
                value={data.settings.replies[channel]}
                onChange={async (e) => {
                  try {
                    await saveCommentSettings({ data: { replies: { [channel]: e.target.value } } });
                    toast.done('Saved');
                    await router.invalidate();
                  } catch (error) {
                    toast.fail(errorText(error));
                  }
                }}
              >
                <option value="off">Off: not read</option>
                <option value="approval">Approval: drafts wait for you</option>
                {data.capabilities[channel]?.reply && <option value="auto">Auto: drafts are sent at once</option>}
              </select>
            </td>
            <td className="muted">{data.capabilities[channel]?.note}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const ALL = 'all';

/** The filters: each one is a change of the address, which is what loads the page */
function Filters({ data, search }: { data: Data; search: CommentsSearch }) {
  const navigate = useNavigate();
  const phone = usePhone();
  const go = (patch: Partial<Record<keyof CommentsSearch, CommentsSearch[keyof CommentsSearch] | undefined>>) => {
    // Any change of filter starts again from the first page; a launch change drops its post
    const next = { ...search, page: undefined, ...(('launch' in patch) && { post: undefined }), ...patch };
    void navigate({ to: '/comments', search: Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== '')), resetScroll: false });
  };
  const states: Array<Option<CommentState | typeof ALL>> = [
    { value: ALL, label: `All (${data.facets.buckets.waiting + data.facets.buckets.replied + data.facets.buckets.ignored})` },
    ...COMMENT_STATES.map((s) => ({ value: s, label: `${COMMENT_STATE_NAMES[s]} (${data.facets.buckets[s]})` })),
  ];
  const channels: Array<Option> = [{ value: ALL, label: 'All channels' }, ...data.facets.channels.map((c) => ({ value: c.channel, label: `${CHANNEL_NAMES[c.channel] ?? c.channel} (${c.count})` }))];
  const launches: Array<Option> = [{ value: ALL, label: 'All launches' }, ...data.facets.launches.map((l) => ({ value: String(l.id), label: `${l.repo.split('/')[1] ?? l.repo} ${l.ref} (${l.count})` }))];
  const posts: Array<Option> = [{ value: ALL, label: 'All posts' }, ...data.facets.posts.map((p) => ({ value: String(p.id), label: `${CHANNEL_NAMES[p.channel] ?? p.channel}${p.kind === 'post' ? '' : ` · ${p.kind}`} (${p.count})` }))];
  const set = (search.state ? 1 : 0) + (search.channel ? 1 : 0) + (search.launch ? 1 : 0) + (search.post ? 1 : 0);
  const trigger = (
    <button type="button" className="btn btn-small stats-filters-button">
      Filters
      {set > 0 && (
        <span className="stats-filters-count">
          {set}
          <span className="visually-hidden"> set</span>
        </span>
      )}
    </button>
  );
  const fields = (
    <div className="comment-filters">
      <Select<CommentState | typeof ALL> label="State" options={states} value={search.state ?? ALL} onValueChange={(v) => go({ state: v === ALL ? undefined : v })} />
      <Select label="Channel" options={channels} value={search.channel ?? ALL} onValueChange={(v) => go({ channel: v === ALL ? undefined : v })} />
      <Select label="Launch" options={launches} value={search.launch ? String(search.launch) : ALL} onValueChange={(v) => go({ launch: v === ALL ? undefined : Number(v) })} />
      {search.launch && <Select label="Post" options={posts} value={search.post ? String(search.post) : ALL} onValueChange={(v) => go({ post: v === ALL ? undefined : Number(v) })} />}
    </div>
  );
  // The words in the bar, the rest one click away: the bar is one row, and a filter set still shows by its count
  return (
    <form
      className="comment-toolbar"
      role="search"
      aria-label="Filter the comments"
      onSubmit={(e) => {
        e.preventDefault();
      }}
    >
      <SearchBox key={search.q ?? ''} value={search.q ?? ''} onSearch={(q) => go({ q: q || undefined })} />
      {phone ? (
        <Drawer title="Filters" trigger={trigger}>
          {fields}
        </Drawer>
      ) : (
        <Popover title="Filters" className="comment-filters-popup" align="start" trigger={trigger}>
          {fields}
        </Popover>
      )}
    </form>
  );
}

/** Words to find: applied as they are typed, once the typing pauses, and at Enter */
function SearchBox({ value, onSearch }: { value: string; onSearch: (q: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => {
    if (text.trim() === value) return;
    const timer = setTimeout(() => onSearch(text.trim()), 400);
    return () => clearTimeout(timer);
  }, [text, value, onSearch]);
  return (
    <div className="comment-search">
      <label className="visually-hidden" htmlFor="comment-search">
        Search
      </label>
      <input
        id="comment-search"
        className="input input-small"
        type="search"
        placeholder="Words in the comment or its author"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSearch(text.trim());
        }}
      />
    </div>
  );
}

function Pager({ page, search }: { page: Data['page']; search: CommentsSearch }) {
  const navigate = useNavigate();
  if (page.pages <= 1) return null;
  const to = (n: number) => void navigate({ to: '/comments', search: { ...search, ...(n > 1 ? { page: n } : { page: undefined }) }, resetScroll: true });
  return (
    <nav className="row comment-pager" aria-label="Pages of comments">
      <button type="button" className="btn btn-small" disabled={page.number <= 1} onClick={() => to(page.number - 1)}>
        Previous
      </button>
      <span className="muted" aria-live="polite">
        Page {page.number} of {page.pages}
      </span>
      <button type="button" className="btn btn-small" disabled={page.number >= page.pages} onClick={() => to(page.number + 1)}>
        Next
      </button>
    </nav>
  );
}

function Comments() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const router = useRouter();
  const toast = useToast();
  const filtered = Object.keys(search).some((k) => k !== 'page');
  return (
    <>
      <PageHead title="Comments" art={<Mailbox width={200} />}>
        The comments on your posts, read every half hour, each with a reply drafted from the repo and the launch’s analysis. Nothing is sent without your click on a channel in approval mode.
      </PageHead>
      <PageToolbar
        label="Comments"
        controls={<Filters data={data} search={search} />}
        actions={
          <ToolbarAction
            primary
            label="Check comments now"
            icon={<RefreshIcon />}
            onClick={async () => {
              const answer = await checkCommentsNow();
              if (answer.ok) toast.done('Checking the comments', 'The drafts appear here when the job ends.');
              else toast.fail(answer.problem);
              await router.invalidate();
            }}
          />
        }
      />
      <h2 className="ph">
        {data.page.total} {data.page.total === 1 ? 'comment' : 'comments'}
      </h2>
      {data.comments.length === 0 ? (
        <p className="muted">{filtered ? 'No comment matches these filters.' : 'No comments yet.'}</p>
      ) : (
        <div className="cards">
          {data.comments.map((c) => (
            <CommentRow key={c.id} comment={c} limit={data.limits[c.channel as Channel] ?? 300} />
          ))}
        </div>
      )}
      <Pager page={data.page} search={search} />

      <h2 className="ph">Replies per channel</h2>
      <Modes data={data} />
    </>
  );
}
