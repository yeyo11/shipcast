import { Link, useRouter } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { agoLabel, deletableFromLine, launchTitle } from '../server/launch-list';
import { launchRepo } from '../server/launches.functions';
import type { AttentionItem } from '../server/attention';
import { Icon } from './kit/Icon';
import { Sheet, SheetClose } from './kit/Sheet';
import { useShell } from './kit/shell';
import { DeleteLaunch } from './launch/DeleteLaunch';
import { useToast } from './Toasts';
import { Menu } from './ui/Menu';
import { usePhone } from './ui/ResponsiveMenu';
import type { HomeLaunch } from './LaunchCard';
import { NetworkGlyph } from './kit/NetworkGlyph';

/*
 * What needs the owner first, on top of the Launches page (boards Main and DesktopHome): the yellow
 * card of a launch whose drafts wait for approval, then a row for each other thing the bell counts.
 */

/** What the yellow card says is ready: the pieces Shipcast holds, or the pull request it drafted */
export function readyText(launch: Pick<HomeLaunch, 'ready' | 'held' | 'pullRequest'>): string {
  const after = 'Nothing goes out until you approve them.';
  if (launch.ready) {
    const n = launch.ready.count;
    return `${n === 1 ? '1 piece is' : `${n} pieces are`} ready: ${launch.ready.text}. ${after}`;
  }
  if (!launch.held && launch.pullRequest) return `Drafts are waiting in the pull request. ${after}`;
  return `Its drafts are ready. ${after}`;
}

export function ApprovalCard({ launch }: { launch: HomeLaunch }) {
  const { title, version } = launchTitle(launch);
  const id = String(launch.id);
  const article = launch.ready?.text.includes('the article') ?? false;
  return (
    <article className="k-card k-wait home-approve" aria-label={`${title}${version ? ` ${version}` : ''} waits for your approval`}>
      <div className="k-hrow k-between">
        <span className="k-hrow k-g6 home-approve-word">
          <Icon name="check" size={16} strokeWidth={3} />
          <span className="k-phone">Approve</span>
          <span className="k-desktop">Waiting for you</span>
        </span>
        <span className="home-approve-ago">drafted {agoLabel(launch.updatedAt)}</span>
      </div>
      <h3 className="k-hrow k-g8 home-approve-name">
        <span className="k-d home-approve-title">{title}</span>
        {version && <span className="k-mono home-approve-version">{version}</span>}
      </h3>
      <p className="home-approve-text">{readyText(launch)}</p>
      <div className="k-hrow k-g10 home-approve-actions">
        <Link className="k-btn k-blk home-approve-review" to="/launches/$id" params={{ id }} search={{ tab: 'content' }}>
          Review the drafts
        </Link>
        {article && (
          <Link className="k-btn k-onyel k-desktop-flex" to="/launches/$id/preview" params={{ id }}>
            <Icon name="eye" size={18} />
            Preview the article
          </Link>
        )}
      </div>
    </article>
  );
}

/** A line's words with its subject in bold, the subject's first letter raised as a title is */
export function Subject({ item }: { item: Pick<AttentionItem, 'text' | 'subject'> }) {
  const { text, subject } = item;
  if (!subject || !text.startsWith(subject)) return <>{text}</>;
  return (
    <>
      <strong>{subject.charAt(0).toUpperCase() + subject.slice(1)}</strong>
      {text.slice(subject.length)}
    </>
  );
}

/** The line's mark: its kind as a shape, the network's for an account */
export function AttentionMark({ item, small = false }: { item: AttentionItem; small?: boolean }) {
  const size = small ? 18 : 20;
  let face: ReactNode;
  let tone = '';
  switch (item.kind) {
    case 'approve':
      face = <Icon name="check" size={18} />;
      tone = ' home-ic-wait';
      break;
    case 'retry':
      face = <span className="k-diamond" style={{ width: 10, height: 10 }} />;
      tone = ' home-ic-bad';
      break;
    case 'reply':
      face = <Icon name="comments" size={size} />;
      break;
    case 'reconnect':
      face = item.channel ? <NetworkGlyph channel={item.channel} size={small ? 16 : 18} /> : <Icon name="key" size={size} />;
      tone = ' home-ic-bad';
      break;
    case 'scheduled':
      face = <Icon name="clock" size={size} />;
      tone = ' home-ic-quiet';
      break;
    default:
      face = <Icon name="help" size={size} />;
  }
  return (
    <span className={`k-ic${small ? ' home-ic-small' : ''}${tone}`} aria-hidden="true">
      {face}
    </span>
  );
}

/** Where a line goes: one branch per route, so the router checks each link at compile time */
export function AttentionLink({ item, className, children, onClick }: { item: AttentionItem; className?: string; children: ReactNode; onClick?: () => void }) {
  const t = item.target;
  const shared = { className, onClick };
  if (t.to === '/launches/$id')
    return (
      <Link {...shared} to={t.to} params={t.params}>
        {children}
      </Link>
    );
  if (t.to === '/comments')
    return (
      <Link {...shared} to={t.to} search={t.search}>
        {children}
      </Link>
    );
  if (t.to === '/settings')
    return (
      <Link {...shared} to={t.to}>
        {children}
      </Link>
    );
  return (
    <Link {...shared} to={t.to} search={t.search}>
      {children}
    </Link>
  );
}

/** The order the rows take under the yellow card: what the owner answers first */
const ROW_ORDER = ['reply', 'retry', 'reconnect', 'permission', 'canonical', 'drift'];

/** The bell's lines that are not the yellow card: the scheduled posts only inform, and stay in the bell */
export function attentionRows(items: readonly AttentionItem[]): AttentionItem[] {
  return items.filter((i) => ROW_ORDER.includes(i.kind)).sort((a, b) => ROW_ORDER.indexOf(a.kind) - ROW_ORDER.indexOf(b.kind));
}

/** On the home rows an account reads as its network: the bell names the account */
function rowItem(item: AttentionItem, network: (channel: string) => string): AttentionItem {
  if (item.kind !== 'reconnect' || !item.channel) return item;
  const name = network(item.channel);
  return { ...item, subject: name, text: `${name} needs reconnecting` };
}

export function AttentionRow({ item, network, deletable }: { item: AttentionItem; network: (channel: string) => string; deletable: boolean }) {
  const shown = rowItem(item, network);
  // Only a launch that failed before anything went out: deleting from a warning never hides a published one
  const failed = deletableFromLine(item);
  return (
    <li className="home-row-item">
      <AttentionLink item={item} className="k-row home-row">
        <AttentionMark item={item} />
        <span className="k-grow home-row-text">
          <Subject item={shown} />
        </span>
        <span className="k-btn k-sm home-row-action">
          {item.kind === 'retry' && <Icon name="retry" size={18} className="k-desktop-inline" />}
          {item.action}
        </span>
      </AttentionLink>
      {failed !== null && deletable && <RowMenu launch={{ id: failed, name: item.subject ?? 'this launch' }} relaunch={null} deletable />}
    </li>
  );
}

/** What a launch's ⋯ can do from the list: launch it again (a failed release) and delete it (with `launch-delete`) */
export interface RowMenuLaunch {
  id: number;
  /** How the menu names it: `Sluice v2.0.0` */
  name: string;
}

/**
 * A launch row's ⋯ (the "Not published" rows, a failed launch's line in what needs you): a sheet on a
 * phone, a menu on a desktop. Delete opens the launch page's own confirmation (DeleteLaunch), with
 * what it would do read first; once it is done the list is read again, so the row leaves in place.
 * Nothing to offer, no button.
 */
export function RowMenu({ launch, relaunch, deletable }: { launch: RowMenuLaunch; relaunch: { repo: string; ref: string } | null; deletable: boolean }) {
  const phone = usePhone();
  const router = useRouter();
  const toast = useToast();
  const { reloadAttention } = useShell();
  const [sheet, setSheet] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!relaunch && !deletable) return null;

  const retry = async () => {
    if (!relaunch) return;
    setBusy(true);
    const answer = await launchRepo({ data: { repo: relaunch.repo, ref: relaunch.ref, direct: false } }).catch((error: unknown) => ({
      ok: false as const,
      problem: error instanceof Error ? error.message : String(error),
    }));
    setBusy(false);
    if (answer.ok) toast.done(`Drafting ${launch.name}`, 'The analysis takes a few minutes; its card shows it while it runs.');
    else toast.fail(answer.problem);
    await Promise.all([router.invalidate(), reloadAttention()]);
  };
  const askDelete = () => {
    setSheet(false);
    setDeleting(true);
  };
  const label = `More for ${launch.name}`;
  const trigger = (
    <button type="button" className="k-btn k-sm k-icon k-ghost home-row-menu" aria-label={label} disabled={busy}>
      <Icon name="more" size={20} />
    </button>
  );

  return (
    <>
      {phone ? (
        <Sheet label={label} open={sheet} onOpenChange={setSheet} trigger={trigger}>
          <h2 className="k-d k-d30">{launch.name}</h2>
          <div className="k-stack">
            {relaunch && (
              <SheetClose render={<button type="button" className="k-mi" onClick={() => void retry()} />}>
                <Icon name="retry" size={22} />
                Launch it again
              </SheetClose>
            )}
            {deletable && (
              <button type="button" className="k-mi k-bad" onClick={askDelete}>
                <Icon name="trash" size={22} />
                Delete
              </button>
            )}
          </div>
        </Sheet>
      ) : (
        <Menu
          align="end"
          trigger={trigger}
          entries={[
            ...(relaunch ? [{ label: 'Launch it again', onSelect: () => void retry() }] : []),
            ...(deletable ? [{ label: 'Delete', tone: 'danger' as const, onSelect: askDelete }] : []),
          ]}
        />
      )}
      {deletable && (
        <DeleteLaunch
          launchId={launch.id}
          open={deleting}
          onOpenChange={setDeleting}
          onDeleted={async () => {
            await Promise.all([router.invalidate(), reloadAttention()]);
          }}
        />
      )}
    </>
  );
}
