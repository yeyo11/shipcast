import { useRouter } from '@tanstack/react-router';
import { useId, useMemo, useState } from 'react';
import { deleteAllPieces, deletePiece, editPiece, editPieces } from '../../server/posts.functions';
import { channelGroups, draftPrefill, networkName, type PieceRow } from '../../server/pieces';
import type { PieceOutcome } from '../../server/post-actions';
import { useToast } from '../Toasts';
import { ConfirmDialog } from '../ui/ConfirmButton';
import { ChannelGroups, type GroupActions } from './ChannelGroups';
import { EditManyDialog, EditPieceDialog } from './EditDialogs';

/*
 * What a launch put out, one row per channel, and what can be done to it: edit a piece, edit several
 * through the shared fields, delete one or all. Every action asks the server, which checks again and
 * answers refusals as data; the page then reads the launch again, so a row always shows the
 * registry's truth rather than a guess.
 */

type Draft = { path: string; content?: string };

const pieceTitle = (row: Pick<PieceRow, 'channel' | 'piece'>) => (row.piece ? `${networkName(row.channel)} ${row.piece}` : networkName(row.channel));

/** Many outcomes as one toast: what went through, and each refusal in the network's or the engine's words */
function summarise(outcomes: PieceOutcome[], verb: string): { ok: boolean; title: string; text: string } {
  const done = outcomes.filter((o) => o.ok).length;
  const failed = outcomes.filter((o): o is Extract<PieceOutcome, { ok: false }> => !o.ok);
  const text = failed.map((o) => `${networkName(o.channel)}: ${o.problem}`).join('\n');
  if (outcomes.length === 0) return { ok: true, title: `Nothing to ${verb.toLowerCase()}`, text: 'No piece of this launch is out on a network that allows it.' };
  return { ok: failed.length === 0, title: `${verb} ${done} of ${outcomes.length}`, text };
}

export function Published({
  launchId,
  repo,
  rows,
  replies,
  drafts,
  notes,
}: {
  launchId: number;
  repo: string;
  rows: PieceRow[];
  replies: Record<string, number>;
  drafts: Draft[];
  /** Each network's capability note: why its actions are what they are */
  notes: Readonly<Record<string, { note: string }>>;
}) {
  const router = useRouter();
  const toast = useToast();
  const groups = useMemo(() => channelGroups(rows, replies), [rows, replies]);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [editing, setEditing] = useState<PieceRow | null>(null);
  const [editingMany, setEditingMany] = useState(false);
  const [deleting, setDeleting] = useState<PieceRow | null>(null);
  const [deletingAll, setDeletingAll] = useState(false);
  const [typed, setTyped] = useState('');
  const typedId = useId();

  const chosen = rows.filter((r) => selected.has(r.id) && r.edit.allowed);
  const deletable = rows.filter((r) => r.remove.allowed);

  const actions: GroupActions = {
    selected,
    onSelect: (ids, on) =>
      setSelected((current) => {
        const next = new Set(current);
        for (const id of ids) (on ? next.add(id) : next.delete(id));
        return next;
      }),
    onEdit: setEditing,
    onDelete: setDeleting,
    note: (channel) => notes[channel]?.note ?? '',
  };

  const after = async () => {
    setSelected(new Set());
    await router.invalidate();
  };

  return (
    <section aria-labelledby="published-title">
      <div className="section-head">
        <h2 className="ph section" id="published-title">
          Published
        </h2>
        <div className="row">
          <button type="button" className="btn btn-small" disabled={chosen.length === 0} onClick={() => setEditingMany(true)}>
            {chosen.length > 1 ? `Edit ${chosen.length} together` : 'Edit selected'}
          </button>
          <button type="button" className="btn btn-small btn-danger" disabled={deletable.length === 0} onClick={() => setDeletingAll(true)}>
            Delete everything
          </button>
        </div>
      </div>
      <p className="muted">Select pieces to edit their text, link or image together. What a network cannot do is greyed out in a row’s menu, with the reason.</p>
      <ChannelGroups groups={groups} actions={actions} />

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
    </section>
  );
}
