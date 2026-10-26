import { Link } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';
import { networkName, type ChannelGroup, type GroupTone, type PieceRow } from '../../server/pieces';
import { ChannelName, number, Pill } from '../ui';
import { CaretIcon, DotsIcon } from '../ui/icons';
import { Menu, type MenuEntry } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';
import { Sparkline } from './Sparkline';

/*
 * The published pieces, one row per channel (docs/web-app.md): a channel with one
 * piece is a plain row; a channel with several folds them under a disclosure button whose summary
 * lists them, and opens on its own when one failed. Only this file knows the markup, so the style
 * of the list can be swapped for tiles or stamps without touching the page's logic.
 */

export interface GroupActions {
  selected: ReadonlySet<number>;
  onSelect(ids: number[], on: boolean): void;
  onEdit(row: PieceRow): void;
  onDelete(row: PieceRow): void;
  /** Says why the actions of this network are what they are: its capability note */
  note(channel: string): string;
}

const TONE: Record<GroupTone, 'published' | 'waiting' | 'failed' | 'manual' | 'draft'> = {
  published: 'published',
  partial: 'waiting',
  failed: 'failed',
  scheduled: 'draft',
  deleted: 'manual',
};

const STATUS: Record<PieceRow['status'], { label: string; tone: 'published' | 'waiting' | 'failed' | 'manual' | 'draft' }> = {
  live: { label: 'Published', tone: 'published' },
  edited: { label: 'Edited', tone: 'published' },
  deleted: { label: 'Deleted', tone: 'manual' },
  scheduled: { label: 'Scheduled', tone: 'draft' },
  failed: { label: 'Failed', tone: 'failed' },
};

const address = (url: string) => url.replace(/^https?:\/\//, '');

function PieceNumber({ row }: { row: PieceRow }) {
  if (!row.metric) return <span className="cg-num muted">no numbers yet</span>;
  const name = row.metric.name.replace(/_/g, ' ');
  return (
    <span className="cg-num" title={`${row.metric.series.length} readings`}>
      <Sparkline values={row.metric.series} />
      <span className="mono">{number(row.metric.value)}</span> <span className="muted">{name}</span>
    </span>
  );
}

/** The row's actions: disabled ones stay, with the reason under them */
function PieceMenu({ row, actions }: { row: PieceRow; actions: GroupActions }) {
  const label = row.piece ? `${networkName(row.channel)} ${row.piece}` : networkName(row.channel);
  const entries: MenuEntry[] = [
    { label: 'Edit', onSelect: () => actions.onEdit(row), disabled: !row.edit.allowed, hint: row.edit.allowed ? undefined : row.edit.reason },
    { label: row.remove.verb, tone: 'danger', onSelect: () => actions.onDelete(row), disabled: !row.remove.allowed, hint: row.remove.allowed ? undefined : row.remove.reason },
    { kind: 'separator' },
    { kind: 'note', label: actions.note(row.channel) },
  ];
  return (
    <Tooltip content={actions.note(row.channel)}>
      <span className="cg-menu">
        <Menu
          trigger={
            <button type="button" className="ui-icon-button" aria-label={`Actions for ${label}`}>
              <DotsIcon />
            </button>
          }
          entries={entries}
        />
      </span>
    </Tooltip>
  );
}

function Check({ ids, actions, label, disabled }: { ids: number[]; actions: GroupActions; label: string; disabled: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const chosen = ids.filter((id) => actions.selected.has(id)).length;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = chosen > 0 && chosen < ids.length;
  }, [chosen, ids.length]);
  return (
    <label className="cg-check">
      <input ref={ref} type="checkbox" checked={ids.length > 0 && chosen === ids.length} disabled={disabled} onChange={(e) => actions.onSelect(ids, e.target.checked)} />
      <span className="visually-hidden">{label}</span>
    </label>
  );
}

function PieceLink({ row, full }: { row: PieceRow; full: boolean }) {
  if (!row.url) return <span className="muted">no address</span>;
  const text = full ? address(row.url) : address(row.url).split('/')[0];
  return (
    <a className="cg-link break" href={row.url} target="_blank" rel="noreferrer">
      {text}
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

function StatusPill({ row }: { row: PieceRow }) {
  const s = STATUS[row.status];
  return <Pill tone={s.tone}>{s.label}</Pill>;
}

function Replies({ group }: { group: ChannelGroup }) {
  if (group.replies === 0) return null;
  return (
    <Link className="cg-replies" to="/comments">
      {group.replies} {group.replies === 1 ? 'reply' : 'replies'}
    </Link>
  );
}

function Account({ row }: { row: PieceRow }) {
  if (!row.account) return null;
  return <span className="muted cg-account">{row.account.handle ?? row.account.label}</span>;
}

function SingleRow({ group, actions }: { group: ChannelGroup; actions: GroupActions }) {
  const row = group.pieces[0]!;
  return (
    <div className="cg-row" data-tone={group.state.tone}>
      <Check ids={[row.id]} actions={actions} label={`Select ${networkName(row.channel)}`} disabled={!row.edit.allowed} />
      <span className="cg-name">
        <ChannelName channel={group.channel} />
      </span>
      <span className="cg-what">
        <PieceLink row={row} full />
        <Account row={row} />
      </span>
      <StatusPill row={row} />
      <PieceNumber row={row} />
      <Replies group={group} />
      <PieceMenu row={row} actions={actions} />
    </div>
  );
}

function MultiRow({ group, actions }: { group: ChannelGroup; actions: GroupActions }) {
  const [opened, setOpened] = useState<boolean | undefined>(undefined);
  const open = opened ?? group.failed;
  const panel = useId();
  const editable = group.pieces.filter((p) => p.edit.allowed).map((p) => p.id);
  return (
    <>
      <div className="cg-row" data-tone={group.state.tone}>
        <Check ids={editable} actions={actions} label={`Select every editable piece of ${networkName(group.channel)}`} disabled={editable.length === 0} />
        <span className="cg-name">
          <ChannelName channel={group.channel} />
        </span>
        <button type="button" className="cg-toggle" aria-expanded={open} aria-controls={panel} onClick={() => setOpened(!open)}>
          <span className="cg-caret" data-open={open}>
            <CaretIcon size={18} />
          </span>
          <span className="cg-summary">{group.pieces.map((p) => p.piece || (p.kind === 'post' ? 'Post' : p.kind)).join(' · ')}</span>
        </button>
        <Pill tone={TONE[group.state.tone]}>{group.state.label}</Pill>
        <Replies group={group} />
      </div>
      <ol id={panel} className="cg-pieces" hidden={!open}>
        {group.pieces.map((row) => (
          <li key={row.id} className="cg-piece" data-status={row.status}>
            <Check ids={[row.id]} actions={actions} label={`Select ${networkName(row.channel)} ${row.piece || row.kind}`} disabled={!row.edit.allowed} />
            <span className="cg-kind mono">{row.piece || (row.kind === 'post' ? 'Post' : row.kind)}</span>
            <span className="cg-what">
              <PieceLink row={row} full />
              <Account row={row} />
            </span>
            <StatusPill row={row} />
            <PieceNumber row={row} />
            <PieceMenu row={row} actions={actions} />
          </li>
        ))}
      </ol>
    </>
  );
}

export function ChannelGroups({ groups, actions }: { groups: ChannelGroup[]; actions: GroupActions }) {
  return (
    <ul className="cg">
      {groups.map((group) => (
        <li key={group.channel} className="cg-group" data-failed={group.failed || undefined}>
          {group.pieces.length === 1 ? <SingleRow group={group} actions={actions} /> : <MultiRow group={group} actions={actions} />}
        </li>
      ))}
    </ul>
  );
}
