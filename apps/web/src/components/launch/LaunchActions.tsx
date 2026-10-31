import { useRouter } from '@tanstack/react-router';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { Diamond, Icon } from '../kit/Icon';
import { Sheet, SheetClose } from '../kit/Sheet';
import { publishAgain } from '../../server/launches.functions';
import { deletePiece, editPiece, editPieces } from '../../server/posts.functions';
import { draftPrefill, networkName, type PieceRow } from '../../server/pieces';
import type { SchedulingChannel } from '../../server/pieces.server';
import { useToast } from '../Toasts';
import { ChannelGlyph, channelTitle } from './ChannelGlyph';
import { DeleteLaunch } from './DeleteLaunch';
import { EditManySheet, PostEditSheet } from './PostEditSheet';
import { MoveSheet } from '../approve/times';
import { UnpublishSheet } from './UnpublishSheet';

/*
 * What can be done to a launch once it is out (boards LaunchMenu, PostEdit, Unpublish, DeleteLaunch):
 * the actions sheet behind the title's ⋯ and the sheets it and the channel rows open. One place
 * holds which sheet is open, so the menu can hand over to the sheet it names. Every action asks the
 * server, which checks again and answers refusals as data; the page then reads the launch again.
 */

const pieceTitle = (row: Pick<PieceRow, 'channel' | 'piece'>) => (row.piece ? `${networkName(row.channel)} ${row.piece}` : networkName(row.channel));

type Open =
  | { kind: 'menu' }
  | { kind: 'pick' }
  | { kind: 'edit'; rows: PieceRow[] }
  | { kind: 'unpublish'; preselect: string[] }
  | { kind: 'delete' }
  | { kind: 'move'; item: SchedulingChannel }
  | null;

export interface LaunchActions {
  openMenu(): void;
  /** Edit these pieces: one in its own sheet, several together */
  edit(rows: PieceRow[]): void;
  unpublish(preselect?: string[]): void;
  /** Give a piece waiting for its time another */
  move(item: SchedulingChannel): void;
  retry(channel: string): Promise<void>;
}

const Context = createContext<LaunchActions | null>(null);

export function useLaunchActions(): LaunchActions {
  const actions = useContext(Context);
  if (!actions) throw new Error('useLaunchActions outside LaunchActionsProvider');
  return actions;
}

export interface LaunchActionsProps {
  launchId: number;
  /** The launch as its heading shows it: the project's name and its version */
  name: string;
  version: string | null;
  rows: PieceRow[];
  drafts: ReadonlyArray<{ path: string; content?: string }>;
  timezone: string;
  /** A launch Shipcast holds: a time left unset publishes on its approval, not on a merge */
  held: boolean;
  articleUrl: string | null;
  /** With launch-delete, and not deleted already */
  deletable: boolean;
  /** A drafted launch whose approved pieces did not all go out: Publish what is pending */
  pending: boolean;
  running: boolean;
  onDeleted: () => Promise<void>;
  children: ReactNode;
}

export function LaunchActionsProvider({ launchId, name, version, rows, drafts, timezone, held, articleUrl, deletable, pending, running, onDeleted, children }: LaunchActionsProps) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);
  const editable = rows.filter((r) => r.edit.allowed);
  const removable = rows.filter((r) => r.remove.allowed);

  const actions = useMemo<LaunchActions>(
    () => ({
      openMenu: () => setOpen({ kind: 'menu' }),
      edit: (chosen) => {
        if (chosen.length === 0) toast.done('Tick what to edit first', 'Tick a channel that allows edits, then Edit selected.');
        else setOpen({ kind: 'edit', rows: chosen });
      },
      unpublish: (preselect = []) => setOpen({ kind: 'unpublish', preselect }),
      move: (item) => setOpen({ kind: 'move', item }),
      retry: async (channel) => {
        const answer = await publishAgain({ data: { id: launchId, channel } });
        if (answer.ok) toast.done(`Trying ${channelTitle(channel)} again`);
        else toast.fail(answer.problem);
        await router.invalidate();
      },
    }),
    [launchId, router, toast],
  );

  const publishPending = async () => {
    close();
    const answer = await publishAgain({ data: { id: launchId } });
    if (answer.ok) toast.done('Publishing what is pending');
    else toast.fail(answer.problem);
    await router.invalidate();
  };

  const editing = open?.kind === 'edit' ? open.rows : [];
  const single = editing.length === 1 ? editing[0] : undefined;
  const moving = open?.kind === 'move' ? open.item : undefined;

  return (
    <Context.Provider value={actions}>
      {children}

      <Sheet label={`${name}, what to do`} open={open?.kind === 'menu'} onOpenChange={(next) => !next && close()}>
        <div className="k-hrow k-g8 pub-menu-head">
          <span className="k-d k-d30">{name}</span>
          {version && <span className="k-mono k-sm k-muted">{version}</span>}
        </div>
        <div className="k-stack">
          {articleUrl && (
            <SheetClose render={<a className="k-mi" href={articleUrl} target="_blank" rel="noreferrer" />}>
              <Icon name="external" />
              Open the article
              <span className="visually-hidden"> (opens in a new tab)</span>
            </SheetClose>
          )}
          {pending && !running && (
            <button type="button" className="k-mi" onClick={publishPending}>
              <Icon name="send" />
              Publish what is pending
            </button>
          )}
          {editable.length > 0 && (
            <button type="button" className="k-mi" onClick={() => (editable.length === 1 ? setOpen({ kind: 'edit', rows: editable }) : setOpen({ kind: 'pick' }))}>
              <Icon name="write" />
              Edit what went out
            </button>
          )}
          {removable.length > 0 && (
            <button type="button" className="k-mi" onClick={() => setOpen({ kind: 'unpublish', preselect: [] })}>
              <Icon name="trash" />
              Unpublish everything
            </button>
          )}
          {deletable && (
            <>
              {(articleUrl || editable.length > 0 || removable.length > 0 || pending) && <div className="k-sep" />}
              <button type="button" className="k-mi k-bad" disabled={running} onClick={() => setOpen({ kind: 'delete' })}>
                <span className="pub-mi-diamond">
                  <Diamond size={10} />
                </span>
                Delete launch
              </button>
            </>
          )}
          {!articleUrl && editable.length === 0 && removable.length === 0 && !deletable && !(pending && !running) && <p className="k-sm k-muted pub-menu-none">Nothing to do to this launch from here yet.</p>}
        </div>
        <SheetClose className="k-btn k-full">Close</SheetClose>
      </Sheet>

      <Sheet label="Edit what went out" open={open?.kind === 'pick'} onOpenChange={(next) => !next && close()}>
        <h2 className="k-d k-d30">Edit what went out</h2>
        <div className="k-stack">
          {editable.map((r) => (
            <button key={r.id} type="button" className="k-mi" onClick={() => setOpen({ kind: 'edit', rows: [r] })}>
              <ChannelGlyph channel={r.channel} size={20} />
              <span className="k-grow">{pieceTitle(r)}</span>
              <Icon name="chevronRight" size={18} />
            </button>
          ))}
        </div>
        <SheetClose className="k-btn k-full">Close</SheetClose>
      </Sheet>

      {single && (
        <PostEditSheet
          key={single.id}
          row={single}
          prefill={draftPrefill(drafts, single)}
          onClose={close}
          onSave={async (changes) => {
            const answer = await editPiece({ data: { postId: single.id, changes } });
            if (!answer.ok) return toast.fail(answer.problem);
            toast.done(`${pieceTitle(single)} edited`, 'The network has the new version.');
            close();
            await router.invalidate();
          }}
        />
      )}
      {editing.length > 1 && (
        <EditManySheet
          rows={editing}
          onClose={close}
          onApply={async (changes) => {
            const answer = await editPieces({ data: { launchId, postIds: editing.map((r) => r.id), changes } });
            if (!answer.ok) return toast.fail(answer.problem);
            const failed = answer.value.filter((o) => !o.ok);
            const done = answer.value.length - failed.length;
            if (failed.length === 0) toast.done(`Edited ${done} of ${answer.value.length}`);
            else toast.fail(`Edited ${done} of ${answer.value.length}\n${failed.map((o) => `${networkName(o.channel)}: ${'problem' in o ? o.problem : ''}`).join('\n')}`);
            close();
            await router.invalidate();
          }}
        />
      )}

      {open?.kind === 'unpublish' && (
        <UnpublishSheet
          name={version ? `${name} ${version}` : name}
          rows={rows}
          preselect={open.preselect}
          onClose={close}
          onConfirm={async (pieces) => {
            // One request per piece, in turn: each network answers for its own, and a refusal stops nothing else
            const problems: string[] = [];
            for (const piece of pieces) {
              const answer = await deletePiece({ data: { postId: piece.id } }).catch((error: unknown) => ({ ok: false as const, problem: error instanceof Error ? error.message : String(error) }));
              if (!answer.ok) problems.push(`${pieceTitle(piece)}: ${answer.problem}`);
            }
            const done = pieces.length - problems.length;
            if (problems.length === 0) toast.done(`Unpublished ${done} of ${pieces.length}`, 'A launch happens once: none of it is published again.');
            else toast.fail(`Unpublished ${done} of ${pieces.length}\n${problems.join('\n')}`);
            close();
            await router.invalidate();
          }}
        />
      )}

      {deletable && <DeleteLaunch launchId={launchId} open={open?.kind === 'delete'} onOpenChange={(next) => !next && close()} onDeleted={onDeleted} />}

      {moving && <MoveSheet launchId={launchId} item={moving} name={channelTitle(moving.channel)} timezone={timezone} onClose={close} />}
    </Context.Provider>
  );
}
