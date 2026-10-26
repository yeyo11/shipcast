import type { Capability } from '@shipcast/engine';
import { Link, useRouter } from '@tanstack/react-router';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { publishAgain } from '../../server/launches.functions';
import { deleteAllPieces, deletePiece, editPiece, editPieces } from '../../server/posts.functions';
import { allowance, channelEntries, draftPrefill, networkName, pieceName, signed, type ChannelEntry, type PieceRow } from '../../server/pieces';
import type { ChannelNumbers, Totals } from '../../server/launch-summary';
import type { SchedulingChannel } from '../../server/pieces.server';
import type { PieceOutcome } from '../../server/post-actions';
import { CHANNEL_NAMES } from '../../server/view';
import { useToast } from '../Toasts';
import { number, Pill, Problem } from '../ui';
import { ConfirmDialog } from '../ui/ConfirmButton';
import { EditManyDialog, EditPieceDialog } from './EditDialogs';
import { ChannelIcon, StateDot } from './Glance';
import { ChannelSchedule } from './Schedule';

/*
 * The launch page's Channels tab (docs/web-app.md): a strip of channel chips, each its network's mark
 * and a state dot, choosing the one channel shown below with its pieces, their links, their numbers
 * over time and what can be done to each. Every action asks the server, which checks again and
 * answers refusals as data; the page then reads the launch again, so a row always shows the
 * registry's truth rather than a guess.
 */

type Draft = { path: string; content?: string };
type Capabilities = Readonly<Record<string, Capability>>;

const pieceTitle = (row: Pick<PieceRow, 'channel' | 'piece'>) => (row.piece ? `${networkName(row.channel)} ${row.piece}` : networkName(row.channel));
const channelTitle = (channel: string) => CHANNEL_NAMES[channel] ?? channel;
const address = (url: string) => url.replace(/^https?:\/\//, '');

/** Many outcomes as one toast: what went through, and each refusal in the network's or the engine's words */
function summarise(outcomes: PieceOutcome[], verb: string): { ok: boolean; title: string; text: string } {
  const done = outcomes.filter((o) => o.ok).length;
  const failed = outcomes.filter((o): o is Extract<PieceOutcome, { ok: false }> => !o.ok);
  const text = failed.map((o) => `${networkName(o.channel)}: ${o.problem}`).join('\n');
  if (outcomes.length === 0) return { ok: true, title: `Nothing to ${verb.toLowerCase()}`, text: 'No piece of this launch is out on a network that allows it.' };
  return { ok: failed.length === 0, title: `${verb} ${done} of ${outcomes.length}`, text };
}

function Check({ row, selected, onSelect }: { row: PieceRow; selected: boolean; onSelect: (on: boolean) => void }) {
  return (
    <label className="post-check">
      <input type="checkbox" checked={selected} disabled={!row.edit.allowed} onChange={(e) => onSelect(e.target.checked)} />
      <span className="visually-hidden">Select {pieceTitle(row)} to edit with others</span>
    </label>
  );
}

/** A metric's name as words: `views_bluesky` → "Views bluesky" */
export const metricWords = (name: string) => {
  const words = name.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * Each number of a piece as a figure: the value large, its name under it, and how much it grew
 * since it was first read. A grid that wraps, so a newsletter's seven numbers never push the row
 * wider than the card; the readings' span is in each figure's title.
 */
function PieceNumbers({ row }: { row: PieceRow }) {
  if (row.numbers.length === 0) return <p className="post-numbers-none muted">No numbers yet</p>;
  return (
    <dl className="post-numbers" aria-label={`Numbers of ${pieceTitle(row)}`}>
      {row.numbers.map((n) => (
        <div key={n.name} title={`${n.series.length} ${n.series.length === 1 ? 'reading' : 'readings'}, from ${n.from.slice(0, 16).replace('T', ' ')} to ${n.to.slice(0, 16).replace('T', ' ')}`}>
          <dt>{metricWords(n.name)}</dt>
          <dd>
            {number(n.value)}
            {n.series.length > 1 && n.value !== n.first && <span className="post-delta">{signed(n.value - n.first)}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const STATUS_WORD: Partial<Record<PieceRow['status'], { label: string; tone: 'published' | 'quiet' | 'failed' }>> = {
  edited: { label: 'Edited', tone: 'published' },
  deleted: { label: 'Deleted', tone: 'quiet' },
  failed: { label: 'Failed', tone: 'failed' },
};

function PieceItem({
  row,
  selected,
  onSelect,
  onEdit,
  onDelete,
  onRetry,
}: {
  row: PieceRow;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onRetry: () => void;
}) {
  const status = STATUS_WORD[row.status];
  return (
    <li className="post-item" data-status={row.status}>
      <Check row={row} selected={selected} onSelect={onSelect} />
      <div className="post-main">
        <span className="post-what">
          {pieceName(row)}
          {status && <Pill tone={status.tone}>{status.label}</Pill>}
        </span>
        {row.account && <span className="muted post-account">{row.account.handle ?? row.account.label}</span>}
        {row.url ? (
          <a className="post-link" href={row.url} target="_blank" rel="noreferrer">
            {address(row.url)}
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        ) : (
          <span className="muted post-link">No address</span>
        )}
      </div>
      <div className="post-actions">
        {row.status === 'failed' ? (
          <button type="button" className="btn btn-small btn-primary" onClick={onRetry}>
            Retry
          </button>
        ) : (
          <>
            {row.edit.allowed && (
              <button type="button" className="btn btn-small" onClick={onEdit} aria-label={`Edit ${pieceTitle(row)}`}>
                Edit
              </button>
            )}
            {row.remove.allowed && (
              <button type="button" className="btn-link" onClick={onDelete} aria-label={`${row.remove.verb} ${pieceTitle(row)}`}>
                {row.remove.verb}
              </button>
            )}
            {!row.edit.allowed && !row.remove.allowed && row.status !== 'deleted' && <span className="muted post-none">No edit or delete here</span>}
          </>
        )}
      </div>
      <PieceNumbers row={row} />
    </li>
  );
}

function ChannelPanel({
  entry,
  capabilities,
  launchId,
  timezone,
  schedule,
  totals,
  selected,
  onSelect,
  onEdit,
  onDelete,
  onRetry,
}: {
  entry: ChannelEntry;
  capabilities: Capabilities;
  launchId: number;
  timezone: string;
  schedule: SchedulingChannel | undefined;
  /** The channel's own totals, from the launch's numbers: what its network counts */
  totals: Partial<Totals> | undefined;
  selected: ReadonlySet<number>;
  onSelect: (id: number, on: boolean) => void;
  onEdit: (row: PieceRow) => void;
  onDelete: (row: PieceRow) => void;
  onRetry: (channel: string) => void;
}) {
  const capability = capabilities[entry.channel];
  const titleId = useId();
  return (
    <section className="chan-panel" aria-labelledby={titleId}>
      <header className="chan-head">
        <h2 className="ph chan-title" id={titleId}>
          <ChannelIcon channel={entry.channel} size={28} /> {channelTitle(entry.channel)}
        </h2>
        <div className="row">
          {entry.replies > 0 && (
            <Link className="chan-replies" to="/comments">
              {entry.replies} {entry.replies === 1 ? 'reply' : 'replies'} sent
            </Link>
          )}
          <StateDot mark={entry.mark} label={entry.label} word />
        </div>
      </header>
      {totals && Object.keys(totals).length > 0 && (
        <p className="chan-numbers" aria-label={`${channelTitle(entry.channel)}'s totals`}>
          {(['views', 'reactions', 'comments', 'clicks'] as const).flatMap((k) =>
            totals[k] === undefined ? [] : [
              <span key={k}>
                <strong>{number(totals[k])}</strong> {k}
              </span>,
            ],
          )}
        </p>
      )}
      {entry.failure !== undefined && (
        <div className="chan-failure">
          <Problem text={entry.failure} />
          <button type="button" className="btn btn-small btn-primary" onClick={() => onRetry(entry.channel)}>
            Retry {channelTitle(entry.channel)}
          </button>
        </div>
      )}
      {entry.pieces.length > 0 && (
        <ul className="post-list">
          {entry.pieces.map((row) => (
            <PieceItem
              key={row.id}
              row={row}
              selected={selected.has(row.id)}
              onSelect={(on) => onSelect(row.id, on)}
              onEdit={() => onEdit(row)}
              onDelete={() => onDelete(row)}
              onRetry={() => onRetry(row.channel)}
            />
          ))}
        </ul>
      )}
      {schedule && <ChannelSchedule launchId={launchId} item={schedule} timezone={timezone} />}
      {capability && (
        <p className="chan-can">
          <strong>{allowance(capability)}.</strong> {capability.note}
        </p>
      )}
    </section>
  );
}

export function Channels({
  launchId,
  repo,
  rows,
  replies,
  drafts,
  capabilities,
  failures,
  scheduling,
  channel,
  onChannel,
  numbers,
}: {
  launchId: number;
  repo: string;
  rows: PieceRow[];
  replies: Record<string, number>;
  drafts: Draft[];
  capabilities: Capabilities;
  failures: ReadonlyArray<{ channel: string; message: string }>;
  scheduling: { timezone: string; channels: SchedulingChannel[] };
  /** The channel shown, from the address; the first one when unset or unknown */
  channel: string | undefined;
  onChannel: (channel: string) => void;
  /** Each channel's totals, from the launch's numbers */
  numbers: Record<string, ChannelNumbers>;
}) {
  const router = useRouter();
  const toast = useToast();
  const entries = useMemo(() => channelEntries({ rows, failures, scheduling: scheduling.channels, replies }), [rows, failures, scheduling.channels, replies]);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [editing, setEditing] = useState<PieceRow | null>(null);
  const [editingMany, setEditingMany] = useState(false);
  const [deleting, setDeleting] = useState<PieceRow | null>(null);
  const [deletingAll, setDeletingAll] = useState(false);
  const [typed, setTyped] = useState('');
  const typedId = useId();
  const stripRef = useRef<HTMLDivElement>(null);

  const current = entries.find((e) => e.channel === channel) ?? entries[0];
  const chosen = rows.filter((r) => selected.has(r.id) && r.edit.allowed);
  const deletable = rows.filter((r) => r.remove.allowed);

  // A channel chosen from the quiet line scrolls its chip into view on a phone, where the strip scrolls sideways
  useEffect(() => {
    stripRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [current?.channel]);

  const after = async () => {
    setSelected(new Set());
    await router.invalidate();
  };
  const retry = async (name: string) => {
    const answer = await publishAgain({ data: { id: launchId, channel: name } });
    if (answer.ok) toast.done(`Trying ${channelTitle(name)} again`);
    else toast.fail(answer.problem);
    await router.invalidate();
  };

  if (!current) return <p className="muted">Nothing went out on a channel yet, and none waits for a time. The drafts are in Content.</p>;

  return (
    <div className="chan">
      <div className="chan-bar">
        <div className="chan-strip" role="group" aria-label="Channel" ref={stripRef}>
          {entries.map((e) => (
            <button
              key={e.channel}
              type="button"
              className={`chan-chip m-${e.mark}`}
              aria-pressed={e.channel === current.channel}
              onClick={() => onChannel(e.channel)}
              title={`${channelTitle(e.channel)}: ${e.label}`}
            >
              <ChannelIcon channel={e.channel} size={20} />
              <span className="visually-hidden">{channelTitle(e.channel)}</span>
              <StateDot mark={e.mark} label={e.label} />
            </button>
          ))}
        </div>
        <div className="chan-bulk">
          <button type="button" className="btn btn-small" disabled={chosen.length === 0} onClick={() => setEditingMany(true)}>
            {chosen.length > 1 ? `Edit ${chosen.length} together` : 'Edit selected'}
          </button>
          <button type="button" className="btn btn-small btn-danger" disabled={deletable.length === 0} onClick={() => setDeletingAll(true)}>
            Delete everything
          </button>
        </div>
      </div>

      <ChannelPanel
        entry={current}
        capabilities={capabilities}
        launchId={launchId}
        timezone={scheduling.timezone}
        schedule={scheduling.channels.find((c) => c.channel === current.channel)}
        totals={numbers[current.channel]?.totals}
        selected={selected}
        onSelect={(id, on) =>
          setSelected((now) => {
            const next = new Set(now);
            if (on) next.add(id);
            else next.delete(id);
            return next;
          })
        }
        onEdit={setEditing}
        onDelete={setDeleting}
        onRetry={retry}
      />
      {selected.size > 0 && (
        <p className="muted chan-selected">
          {chosen.length} selected across channels: {chosen.map(pieceTitle).join(', ')}.
        </p>
      )}

      {editing && (
        <EditPieceDialog
          row={editing}
          prefill={draftPrefill(drafts, editing)}
          onClose={() => setEditing(null)}
          onSave={async (changes) => {
            const answer = await editPiece({ data: { postId: editing.id, changes } });
            if (answer.ok) {
              toast.done(`${pieceTitle(editing)} edited`, 'The network has the new version.');
              setEditing(null);
              await after();
            } else toast.fail(answer.problem);
          }}
        />
      )}

      {editingMany && (
        <EditManyDialog
          rows={chosen}
          onClose={() => setEditingMany(false)}
          onApply={async (changes) => {
            const answer = await editPieces({ data: { launchId, postIds: chosen.map((r) => r.id), changes } });
            if (!answer.ok) return toast.fail(answer.problem);
            const s = summarise(answer.value, 'Edited');
            if (s.ok) toast.done(s.title, s.text);
            else toast.fail(`${s.title}\n${s.text}`);
            setEditingMany(false);
            await after();
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleting(null)}
          title={`${deleting.remove.verb} ${pieceTitle(deleting)}?`}
          description={
            <>
              <p>{deleting.remove.reason}</p>
              <p>A launch happens once: Shipcast will not publish this piece again.</p>
            </>
          }
          confirm={deleting.remove.verb}
          onConfirm={async () => {
            const answer = await deletePiece({ data: { postId: deleting.id } });
            if (answer.ok) toast.done(`${pieceTitle(deleting)} ${deleting.remove.verb === 'Unpublish' ? 'unpublished' : 'deleted'}`);
            else toast.fail(answer.problem);
            setDeleting(null);
            await after();
          }}
        />
      )}

      <ConfirmDialog
        open={deletingAll}
        onOpenChange={(open) => {
          setDeletingAll(open);
          if (!open) setTyped('');
        }}
        title="Delete everything this launch published?"
        description={
          <>
            <p>
              {deletable.length} {deletable.length === 1 ? 'piece goes' : 'pieces go'}: {deletable.map(pieceTitle).join(', ')}. dev.to’s articles are unpublished instead.
            </p>
            {rows.length > deletable.length && <p>What a network cannot delete (Instagram, the newsletter, a story) stays.</p>}
            <p>A launch happens once: none of it is published again.</p>
          </>
        }
        body={
          <div className="field">
            <label htmlFor={typedId}>Type {repo} to confirm</label>
            <input id={typedId} className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
          </div>
        }
        confirm="Delete everything"
        confirmDisabled={typed.trim() !== repo}
        onConfirm={async () => {
          const answer = await deleteAllPieces({ data: { launchId, confirm: typed.trim() } });
          setTyped('');
          if (!answer.ok) return toast.fail(answer.problem);
          const s = summarise(answer.value, 'Deleted');
          if (s.ok) toast.done(s.title, s.text);
          else toast.fail(`${s.title}\n${s.text}`);
          await after();
        }}
      />
    </div>
  );
}
