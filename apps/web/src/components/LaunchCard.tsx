import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { groupChannels, type ChannelGroup, type LaunchView } from '../server/view';
import { ChannelName, number, Pill, when } from './ui';
import { CaretIcon } from './ui/icons';
import { Tooltip } from './ui/Tooltip';

type Piece = ChannelGroup['pieces'][number];

function PieceLink({ piece }: { piece: Piece }) {
  if (!piece.url) return <>{piece.failure ?? ''}</>;
  return (
    // Clamped to one line on wide screens, so the full address is on hover and focus too
    <Tooltip content={piece.url}>
      <a href={piece.url} target="_blank" rel="noreferrer">
        {piece.url.replace(/^https:\/\//, '')}
      </a>
    </Tooltip>
  );
}

const replies = (n: number) => (n === 0 ? null : <span className="launch-replies">{n === 1 ? '1 reply' : `${n} replies`}</span>);

/**
 * One channel of the card. A channel with several pieces (an article per language, a post with its
 * story) is one row that opens to them, so the card never shows the same channel twice; one with a
 * failure starts open, since a failure folded away is a failure missed.
 */
function ChannelRow({ group }: { group: ChannelGroup }) {
  const [opened, setOpened] = useState<boolean | undefined>(undefined);
  const open = opened ?? group.hasFailure;
  const panel = useId();
  const only = group.pieces[0];
  return (
    <li className="launch-channel">
      <ChannelName channel={group.channel} />
      <span className="post">
        {!group.expandable && only ? (
          <>
            {only.label !== 'Post' && <span className="mono">{only.label} </span>}
            <PieceLink piece={only} />
          </>
        ) : (
          <button type="button" className="launch-toggle" aria-expanded={open} aria-controls={panel} onClick={() => setOpened(!open)}>
            <span className="launch-caret" data-open={open || undefined}>
              <CaretIcon size={16} />
            </span>
            <span className="mono">{group.pieces.map((p) => p.label).join(' · ')}</span>
          </button>
        )}
        {replies(group.replies)}
      </span>
      <Pill tone={group.state.tone}>{group.state.label}</Pill>
      {group.expandable && (
        <ul id={panel} className="launch-pieces" hidden={!open}>
          {group.pieces.map((p) => (
            <li key={p.key}>
              <span className="mono">{p.label}</span>
              <span className="post">
                <PieceLink piece={p} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** A launch as the specimen's launch card: black, a yellow stamp, one row per channel */
export function LaunchCard({ launch }: { launch: LaunchView }) {
  const groups = groupChannels(launch);
  return (
    <article className="launch">
      <div className="launch-head">
        <div>
          <h2>
            <Link to="/launches/$id" params={{ id: String(launch.id) }}>
              {launch.repo.split('/')[1]} <span className="mono">{launch.ref.startsWith('article:') ? '' : launch.ref}</span>
            </Link>
          </h2>
          <p>
            {launch.repo} · {launch.kind} · {when(launch.createdAt)}
            {launch.headline.length > 0 && <> · {launch.headline.map((h) => `${number(h.value)} ${h.label}`).join(' · ')}</>}
          </p>
        </div>
        <Pill tone={launch.state.tone}>{launch.state.label}</Pill>
      </div>
      {groups.length > 0 ? (
        <ol>
          {groups.map((group) => (
            <ChannelRow key={group.channel} group={group} />
          ))}
        </ol>
      ) : (
        <ol>
          <li>
            <span />
            <span className="post" style={{ gridColumn: 'span 2' }}>
              {launch.problem ? launch.problem.split('\n')[0] : launch.pullRequest ? 'Drafts are waiting in the pull request.' : 'Nothing published yet.'}
            </span>
            <Link className="btn btn-small" style={{ color: 'inherit' }} to="/launches/$id" params={{ id: String(launch.id) }}>
              Open
            </Link>
          </li>
        </ol>
      )}
    </article>
  );
}
