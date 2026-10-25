import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { useToast } from '../../components/Toasts';
import { ChannelName, Pill, when } from '../../components/ui';
import { approveReply, checkCommentsNow, dismissReply, listComments, redraftReply, saveCommentSettings, saveReply } from '../../server/comments.functions';
import type { Tone } from '../../server/view';

/*
 * The comment assistant's page, plain on purpose: the list, each draft with its actions, and each
 * channel's mode. Its design comes with the rebuilt interface.
 */

export const Route = createFileRoute('/_app/comments')({
  head: () => ({ meta: [{ title: 'Comments · Shipcast' }] }),
  loader: () => listComments(),
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
  dismissed: { label: 'Dismissed', tone: 'manual' },
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
                <button
                  className="btn btn-primary btn-small"
                  type="button"
                  disabled={busy || !draft.trim()}
                  onClick={() => {
                    if (!window.confirm(`Send this reply to ${comment.author.handle} in your name?`)) return;
                    void run(async () => {
                      if (draft !== (comment.draft ?? '')) await saveReply({ data: { id: comment.id, draft } });
                      await approveReply({ data: comment.id });
                    }, 'Reply sent');
                  }}
                >
                  Approve and send
                </button>
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

function Comments() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const toast = useToast();
  const waiting = data.comments.filter((c) => c.status !== 'sent' && c.status !== 'dismissed');
  const done = data.comments.filter((c) => c.status === 'sent' || c.status === 'dismissed');
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="ph">Comments</h1>
          <p>The comments on your posts of the last 30 days, read every half hour, each with a reply drafted from the repo and the launch’s analysis. Nothing is sent without your click on a channel in approval mode.</p>
        </div>
        <button
          className="btn"
          type="button"
          onClick={async () => {
            const answer = await checkCommentsNow();
            if (answer.ok) toast.done('Checking the comments', 'The drafts appear here when the job ends.');
            else toast.fail(answer.problem);
            await router.invalidate();
          }}
        >
          Check comments now
        </button>
      </div>

      <h2 className="ph">Waiting</h2>
      {waiting.length === 0 ? <p className="muted">Nothing waits for you.</p> : <div className="cards">{waiting.map((c) => <CommentRow key={c.id} comment={c} limit={data.limits[c.channel as Channel] ?? 300} />)}</div>}

      <h2 className="ph">Answered and dismissed</h2>
      {done.length === 0 ? <p className="muted">None yet.</p> : <div className="cards">{done.map((c) => <CommentRow key={c.id} comment={c} limit={data.limits[c.channel as Channel] ?? 300} />)}</div>}

      <h2 className="ph">Replies per channel</h2>
      <Modes data={data} />
    </>
  );
}
