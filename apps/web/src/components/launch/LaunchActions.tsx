import { Link, useRouter } from '@tanstack/react-router';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { Diamond, Icon } from '../kit/Icon';
import { Overlay, OverlayClose } from '../kit/Overlay';
import { usePhone } from '../kit/usePhone';
import { desktopMenuEntries, launchMenuEntries, type LaunchMenuEntry } from './launch-menu';
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
  /** `anchor`: the ⋯ it was opened from, which a desktop's menu hangs from */
  openMenu(anchor?: HTMLElement): void;
  /** What the menu offers in the window's current shape: nothing, and the page shows no ⋯ */
  menu: LaunchMenuEntry[];
  /** Launching a failed release again, when it can be; the desktop's header shows it as its button */
  relaunch: { run: () => Promise<void>; busy: boolean } | null;
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
  /** Waiting for the owner's approval: its text to edit and, for a launch Shipcast holds, the article's preview */
  waiting?: boolean;
  running: boolean;
  /** canRelaunch: launching it again the way the failed card does ($id.tsx) */
  relaunch: { run: () => Promise<void>; busy: boolean } | null;
  /** Why it failed, when it did */
  problem: string | null;
  failed: boolean;
  onDeleted: () => Promise<void>;
  children: ReactNode;
}

export function LaunchActionsProvider({ launchId, name, version, rows, drafts, timezone, held, articleUrl, deletable, pending, waiting = false, running, relaunch, problem, failed, onDeleted, children }: LaunchActionsProps) {
  const router = useRouter();
  const toast = useToast();
  const phone = usePhone();
  const [open, setOpen] = useState<Open>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = () => setOpen(null);
  const editable = rows.filter((r) => r.edit.allowed);
  const removable = rows.filter((r) => r.remove.allowed);
  const relaunching = relaunch?.busy ?? false;
  const all = launchMenuEntries({
    relaunch: relaunch !== null,
    waiting,
    held,
    article: articleUrl !== null,
    pending,
    running,
    failed,
    problem: Boolean(problem),
    editable: editable.length,
    removable: removable.length,
    deletable,
  });
  const menu = phone ? all : desktopMenuEntries(all);
  const has = (entry: LaunchMenuEntry) => menu.includes(entry);
  const menuKey = menu.join();

  const copyProblem = async () => {
    try {
      await navigator.clipboard.writeText(problem ?? '');
      toast.done('Error copied');
    } catch {
      toast.fail('Could not copy the error');
    }
  };

  const actions = useMemo<LaunchActions>(
    () => ({
      openMenu: (from) => {
        setAnchor(from ?? null);
        setOpen((now) => (now?.kind === 'menu' ? null : { kind: 'menu' }));
      },
      menu: menuKey ? (menuKey.split(',') as LaunchMenuEntry[]) : [],
      relaunch,
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
    [launchId, router, toast, menuKey, relaunch],
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

      <Overlay
        kind="menu"
        label={`${name}, what to do`}
        open={open?.kind === 'menu'}
        onOpenChange={(next) => !next && close()}
        anchor={anchor}
        footer={<OverlayClose className="k-btn k-full k-sheet-only">Close</OverlayClose>}
      >
        <div className="k-hrow k-g8 pub-menu-head k-sheet-only">
          <span className="k-d k-d30">{name}</span>
          {version && <span className="k-mono k-sm k-muted">{version}</span>}
        </div>
        <div className="k-stack">
          {has('relaunch') && (
            <OverlayClose render={<button type="button" className="k-mi k-sheet-only" disabled={running || relaunching} onClick={() => void relaunch?.run()} />}>
              <Icon name="retry" />
              Launch it again
            </OverlayClose>
          )}
          {has('edit-text') && (
            <OverlayClose nativeButton={false} render={<Link className="k-mi" to="/launches/$id/edit" params={{ id: String(launchId) }} />}>
              <Icon name="write" />
              Edit the text
            </OverlayClose>
          )}
          {has('preview') && (
            <OverlayClose nativeButton={false} render={<Link className="k-mi" to="/launches/$id/preview" params={{ id: String(launchId) }} />}>
              <Icon name="eye" />
              Preview the article
            </OverlayClose>
          )}
          {has('article') && articleUrl && (
            <OverlayClose nativeButton={false} render={<a className="k-mi" href={articleUrl} target="_blank" rel="noreferrer" />}>
              <Icon name="external" />
              Open the article
              <span className="visually-hidden"> (opens in a new tab)</span>
            </OverlayClose>
          )}
          {has('publish-pending') && (
            <button type="button" className="k-mi" onClick={publishPending}>
              <Icon name="send" />
              Publish what is pending
            </button>
          )}
          {has('log') && (
            <OverlayClose nativeButton={false} render={<Link className="k-mi" to="/launches/$id" params={{ id: String(launchId) }} search={(prev) => ({ ...prev, tab: 'details' })} replace resetScroll={false} />}>
              <Icon name="external" />
              The job’s log
            </OverlayClose>
          )}
          {has('copy-error') && (
            <OverlayClose render={<button type="button" className="k-mi" onClick={() => void copyProblem()} />}>
              <Icon name="copy" />
              Copy the error
            </OverlayClose>
          )}
          {has('edit-out') && (
            <button type="button" className="k-mi" onClick={() => (editable.length === 1 ? setOpen({ kind: 'edit', rows: editable }) : setOpen({ kind: 'pick' }))}>
              <Icon name="write" />
              Edit what went out
            </button>
          )}
          {has('unpublish') && (
            <button type="button" className="k-mi" onClick={() => setOpen({ kind: 'unpublish', preselect: [] })}>
              <Icon name="trash" />
              Unpublish everything
            </button>
          )}
          {has('delete') && (
            <>
              {menu.some((e) => e !== 'delete' && e !== 'relaunch') && <div className="k-sep" role="separator" />}
              <button type="button" className="k-mi k-bad" disabled={running} onClick={() => setOpen({ kind: 'delete' })}>
                <span className="pub-mi-diamond">
                  <Diamond size={10} />
                </span>
                Delete launch
              </button>
            </>
          )}
        </div>
      </Overlay>

      <Overlay
        kind="menu"
        label="Edit what went out"
        heading="Edit what went out"
        open={open?.kind === 'pick'}
        onOpenChange={(next) => !next && close()}
        anchor={anchor}
        footer={<OverlayClose className="k-btn k-full k-sheet-only">Close</OverlayClose>}
      >
        <div className="k-stack">
          {editable.map((r) => (
            <button key={r.id} type="button" className="k-mi" onClick={() => setOpen({ kind: 'edit', rows: [r] })}>
              <ChannelGlyph channel={r.channel} size={20} />
              <span className="k-grow">{pieceTitle(r)}</span>
              <Icon name="chevronRight" size={18} />
            </button>
          ))}
        </div>
      </Overlay>

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
