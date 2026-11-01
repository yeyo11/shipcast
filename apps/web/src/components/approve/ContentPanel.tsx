import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { CHANNEL_NAMES } from '../../server/view';
import { channelOfDraft } from '../assistant/protocol';
import { Icon } from '../kit/Icon';
import { piecesOf } from './model';
import type { LaunchData } from './parts';

/*
 * A launch's Content tab when it is not waiting for the owner (published, failed, set aside): the
 * same cards as the launch to approve (board LaunchContent), without the approval, each opening its
 * text in the drafts editor, read-only once the launch has gone out.
 */

const nameOf = (channel: string) => (channel === 'blog' ? 'Blog' : (CHANNEL_NAMES[channel] ?? channel));

export function LaunchContentPanel({ data, running }: { data: LaunchData; running: boolean }) {
  const { launch, review } = data;
  const reviewOk = review && !('error' in review) ? review : undefined;
  const texts = useMemo(() => reviewOk?.drafts.filter((d) => d.kind === 'article' || d.kind === 'channel') ?? [], [reviewOk]);
  const media = reviewOk?.drafts.filter((d) => d.kind === 'image' || d.kind === 'video') ?? [];
  const pieces = useMemo(() => piecesOf(texts, channelOfDraft, nameOf), [texts]);
  const params = { id: String(launch.id) };
  const editable = reviewOk?.app ? reviewOk.app.open : reviewOk?.pullRequest?.state === 'open';
  return (
    <div className="k-px k-stack k-g12 ap-mt14 ap-content-panel">
      {review && 'error' in review && (
        <div className="k-notice k-bad">
          <span className="ap-diamond" aria-hidden="true" />
          <div className="k-grow">Could not read the drafts: {review.error}</div>
        </div>
      )}
      {pieces.length > 0 && (
        <div className="k-hrow k-between">
          <span className="k-sm k-muted">{editable ? 'The drafts' : 'What went out'}</span>
          <Link className="k-btn k-sm" to="/launches/$id/edit" params={params}>
            <Icon name="write" size={18} />
            {editable ? 'Edit the text' : 'Read the text'}
          </Link>
        </div>
      )}
      <div className="ap-dcards ap-dcards-flex">
        {pieces.map((p) => (
          <article key={p.id} className="k-card" aria-label={p.name}>
            <div className="k-hrow k-between k-g8">
              <strong className="ap-card-name">{p.name}</strong>
            </div>
            <div className="k-sm k-clamp3">{p.excerpt}</div>
            <div className="k-xs k-muted">{p.meta}</div>
            <div className="k-hrow k-g8">
              <Link className="k-btn k-sm" to="/launches/$id/edit" params={params} search={{ draft: p.id }}>
                {editable ? 'Edit' : 'Read'}
              </Link>
            </div>
          </article>
        ))}
      </div>
      {media.length > 0 && (
        <div className="k-card k-flat ap-media">
          <div className="k-hrow k-between">
            <strong>Media</strong>
            <span className="k-xs k-muted">
              {media.length} {media.length === 1 ? 'file' : 'files'}
            </span>
          </div>
          <div className="k-hrow k-g8">
            {media.map((m) =>
              m.kind === 'video' ? (
                <video key={m.path} className="ap-thumb" src={m.url} muted controls />
              ) : (
                <a key={m.path} className="ap-thumb" href={m.url} target="_blank" rel="noreferrer">
                  <img src={m.url} alt={m.label} loading="lazy" />
                </a>
              ),
            )}
          </div>
        </div>
      )}
      {pieces.length === 0 && media.length === 0 && (
        <div className="k-card k-quiet">
          <strong>{running ? 'Drafting…' : launch.problem ? 'Nothing was drafted' : 'No drafts here'}</strong>
          <span className="k-sm k-muted">
            {running
              ? 'Shipcast is reading the code and writing each piece; the drafts show here when they are ready.'
              : launch.problem
                ? 'The launch failed before its drafts were written: the reason is above, and the job’s log is in Details.'
                : launch.posts.length > 0
                  ? 'The drafts of this launch could not be read.'
                  : 'Nothing was drafted for this launch yet.'}
          </span>
        </div>
      )}
    </div>
  );
}
