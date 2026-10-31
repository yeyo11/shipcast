import { Link, useRouter } from '@tanstack/react-router';
import { useMemo, useState, type ReactNode } from 'react';
import { approveDrafts } from '../../server/launches.functions';
import type { SchedulingChannel } from '../../server/pieces.server';
import { CHANNEL_NAMES } from '../../server/view';
import { channelOfDraft } from '../assistant/protocol';
import { Diamond, Icon } from '../kit/Icon';
import { TopBar } from '../kit/Bars';
import { useToast } from '../Toasts';
import { ago, piecesOf, timeLabel, type Piece } from './model';
import { Glyph, useMarks, useNow, type DraftView, type LaunchData, type ReviewOk } from './parts';
import { ScheduleSheet, Times, useChipsFor, type ChannelChips } from './times';

/*
 * A launch waiting for the owner's approval (boards LaunchReview, LaunchContent and
 * DesktopLaunchReview): where each channel goes and when, each piece to read and tick, and the one
 * yellow action that approves what is left. Approving records the drafts as they are now
 * (docs/app-review.md); the article goes to the site, then every channel at its time.
 */

export type ApprovalTab = 'channels' | 'content' | 'search' | 'details';

export interface LaunchApprovalProps {
  data: LaunchData;
  tab: ApprovalTab;
  onTab: (tab: ApprovalTab) => void;
  /** The channel whose times are open, from the address */
  channel: string | undefined;
  onChannel: (channel: string) => void;
  /** The Search engines and Details tabs, which every state of the launch page shares */
  search: ReactNode;
  details: ReactNode;
  /** The launch's actions behind "…" (board LaunchMenu) */
  menu: ReactNode;
}

const nameOf = (channel: string) => (channel === 'blog' ? 'Blog' : (CHANNEL_NAMES[channel] ?? channel));

/** One line of the Channels tab: the blog's article or a channel with its time */
interface ChannelLine {
  channel: string;
  piece: Piece<DraftView> | undefined;
  sched: SchedulingChannel | undefined;
}

export function LaunchApproval({ data, tab, onTab, channel, onChannel, search, details, menu }: LaunchApprovalProps) {
  const router = useRouter();
  const toast = useToast();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [another, setAnother] = useState<string | null>(null);
  const { launch, pieces: launchPieces } = data;
  const review: ReviewOk | undefined = data.review && !('error' in data.review) ? data.review : undefined;
  const app = review?.app;
  const timezone = launchPieces.scheduling.timezone;
  const texts = useMemo(() => review?.drafts.filter((d) => d.kind === 'article' || d.kind === 'channel') ?? [], [review]);
  const media = review?.drafts.filter((d) => d.kind === 'image' || d.kind === 'video') ?? [];
  const pieces = useMemo(() => piecesOf(texts, channelOfDraft, nameOf), [texts]);
  const marks = useMarks(launch.id, pieces);
  const sched = new Map(launchPieces.scheduling.channels.map((c) => [c.channel as string, c]));
  const isAuto = (p: Piece<DraftView>) => sched.get(p.id)?.mode === 'auto';
  const approved = (p: Piece<DraftView>) => isAuto(p) || marks.isApproved(p);
  const total = pieces.length;
  const done = pieces.filter(approved).length;
  const left = total - done;
  const cta = done === 0 ? (total === 1 ? 'Approve it' : `Approve all ${total}`) : left === 0 ? 'Approve and publish' : `Approve the other ${left}`;

  // The blog first, then every channel with a draft in the pack's order, then any channel launch.yml adds without one
  const lines: ChannelLine[] = [
    ...pieces.map((p) => ({ channel: p.id, piece: p, sched: sched.get(p.id) })),
    ...launchPieces.scheduling.channels.filter((c) => !pieces.some((p) => p.id === c.channel)).map((c) => ({ channel: c.channel as string, piece: undefined, sched: c })),
  ];
  // The channel whose times are open: the one in the address, else the first that can go out
  const open = channel ?? lines.find((l) => l.sched && !l.sched.broken)?.channel;
  const anotherItem = another ? sched.get(another) : undefined;
  const chipsOf = useChipsFor(launchPieces.scheduling.channels.map((c) => c.channel));

  const approve = async () => {
    setBusy(true);
    // The versions on screen: a draft changed since the page was read is refused, not approved unseen
    const answer = await approveDrafts({ data: { id: launch.id, ...(app && { versions: app.versions }) } }).catch((error: unknown) => ({ ok: false as const, problem: error instanceof Error ? error.message : String(error) }));
    setBusy(false);
    if (answer.ok) {
      marks.clear();
      toast.done('Approved', app ? 'The article goes to the site; once it is live, every approved channel publishes at its time.' : 'The pull request is merged; the blog deploys, then every channel publishes.');
    } else toast.fail(answer.problem);
    await router.invalidate();
  };

  const project = launch.ref.startsWith('article:') ? 'Article' : (launch.repo.split('/')[1] ?? launch.repo);
  const version = launch.ref.startsWith('article:') ? null : launch.ref;
  const params = { id: String(launch.id) };
  const changedSince = app?.approval ? Object.keys(app.waiting) : [];
  const previewLink = app ? (
    <Link to="/launches/$id/preview" params={params} className="k-btn k-onyel">
      <Icon name="eye" size={18} />
      Preview
    </Link>
  ) : review?.pullRequest ? (
    <a className="k-btn k-onyel" href={review.pullRequest.url} target="_blank" rel="noreferrer">
      <Icon name="external" size={18} />
      Pull request
    </a>
  ) : null;

  const tabs = (desktop: boolean) => (
    <div role="tablist" aria-label="This launch" className={`k-tabs${desktop ? '' : ' ap-tabs'}`}>
      {(
        [
          ['channels', 'Channels'],
          ['content', 'Content'],
          ['search', desktop ? 'Search engines' : 'Search'],
          ['details', 'Details'],
        ] as const
      ).map(([id, label]) => (
        <button key={id} type="button" role="tab" aria-selected={tab === id} className={`k-tab${tab === id ? ' k-on' : ''}`} onClick={() => onTab(id)}>
          {label}
          {id === 'content' && total > 0 && <span className="k-n">{total}</span>}
        </button>
      ))}
    </div>
  );

  const notices = (
    <>
      {data.review && 'error' in data.review && (
        <div className="k-notice k-bad">
          <Diamond size={9} />
          <div className="k-grow">Could not read the drafts: {data.review.error}</div>
        </div>
      )}
      {changedSince.length > 0 && (
        <div className="k-notice k-wait">
          <div className="k-grow">
            <strong>Changed since it was approved:</strong> {changedSince.map(nameOf).join(', ')}. Approve again to send {changedSince.length === 1 ? 'it' : 'them'}.
          </div>
        </div>
      )}
      {data.fakeNetworks && (
        <div className="k-notice k-wait">
          <div className="k-grow">
            <strong>A preview with fake networks.</strong> Edits, times and approvals change this copy of the data only: no request reaches a network, and nothing is written to GitHub.
          </div>
        </div>
      )}
    </>
  );

  const contentCards = (
    <>
      {pieces.map((p) => {
        const ok = approved(p);
        return (
          <article key={p.id} className={`k-card${ok ? '' : ' ap-card-open'}`} aria-label={p.name}>
            <div className="k-hrow k-between k-g8">
              <strong className="ap-card-name">{p.name}</strong>
              {isAuto(p) ? <span className="k-pill k-p-draft">Auto</span> : <span className={`k-pill ${ok ? 'k-p-pub' : 'k-p-draft'}`}>{ok ? 'Approved' : 'Not approved'}</span>}
            </div>
            <div className="k-sm k-clamp3">{p.excerpt}</div>
            <div className="k-xs k-muted">{p.meta}</div>
            <div className="k-hrow k-g8">
              <Link className="k-btn k-sm" to="/launches/$id/edit" params={params} search={{ draft: p.id }}>
                Edit
              </Link>
              {!isAuto(p) && (
                <button type="button" className={`k-btn k-sm ap-toggle${ok ? ' ap-undo' : ''}`} aria-pressed={ok} onClick={() => marks.toggle(p)}>
                  {ok ? 'Undo' : 'Approve'}
                  <span className="visually-hidden"> {p.name}</span>
                </button>
              )}
            </div>
          </article>
        );
      })}
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
      {pieces.length === 0 && <p className="k-sm k-muted">There are no texts to review.</p>}
    </>
  );

  const ticks = [...pieces].sort((a, b) => Number(approved(b)) - Number(approved(a)));

  return (
    <div className="ap-screen">
      {/* ---------- Phone (boards LaunchReview, LaunchContent) ---------- */}
      <div className="k-phone">
        <TopBar back={{ label: 'Launches', to: '/' }} />
        <div className="k-px k-stack k-g10 ap-head">
          <div className="k-hrow k-between k-g8 ap-top">
            <div className="k-hrow k-g10 k-wrap ap-base">
              <h1 className="k-d k-d48">{project}</h1>
              {version && <span className="k-mono k-muted">{version}</span>}
            </div>
            {menu}
          </div>
          <div className="k-hrow k-g10 k-wrap">
            <span className="k-pill k-p-wait">Waiting for you</span>
            <span className="k-sm k-muted">
              {launch.repo} · drafted <span suppressHydrationWarning>{ago(launch.createdAt, now)}</span>
            </span>
          </div>
        </div>
        <div className="ap-tabs-wrap">{tabs(false)}</div>

        {tab === 'channels' && (
          <>
            <div className="k-px ap-mt14 k-stack k-g10">
              <div className="k-notice k-wait">
                <span className="k-muted ap-notice-icon">
                  <Icon name="help" size={18} />
                </span>
                <div className="k-grow">Approving records the drafts as they are now: the article goes to the site, then every approved channel at its time.</div>
              </div>
            </div>
            <div className="k-px k-stack ap-mt6">
              {lines.map((l) => (
                <ChannelRow key={l.channel} line={l} times={chipsOf(l.channel)} launchId={launch.id} timezone={timezone} now={now} open={open === l.channel} onOpen={() => onChannel(l.channel)} onAnotherDay={() => setAnother(l.channel)} />
              ))}
            </div>
            <div className="k-px k-stack k-g10">{notices}</div>
          </>
        )}
        {tab === 'content' && (
          <>
            <div className="k-px k-hrow k-between ap-mt14">
              <span className="k-sm k-muted">
                {done} of {total} approved
              </span>
              <Link className="k-btn k-sm" to="/launches/$id/edit" params={params}>
                <Icon name="write" size={18} />
                Edit the text
              </Link>
            </div>
            <div className="k-px k-stack k-g12 ap-mt12">
              {contentCards}
              {notices}
            </div>
          </>
        )}
        {tab === 'search' && <div className="k-px ap-mt14">{search}</div>}
        {tab === 'details' && <div className="k-px ap-mt14">{details}</div>}
        <div className="ap-bar-space" aria-hidden="true" />
        <div className="k-bar k-yel ap-bar" role="region" aria-label="Waiting for you">
          <div className="k-hrow k-between">
            <span className="k-d k-d24">Waiting for you</span>
            <span className="k-xs ap-strong">
              {done} of {total} approved
            </span>
          </div>
          <div className="k-hrow k-g10">
            {previewLink}
            <button type="button" className="k-btn k-blk ap-grow-btn" disabled={busy} onClick={approve}>
              <Icon name="check" size={18} />
              {busy ? 'Approving…' : cta}
            </button>
          </div>
        </div>
      </div>

      {/* ---------- Desktop (board DesktopLaunchReview) ---------- */}
      <div className="k-desktop">
        <div className="k-page">
          <Link to="/" className="k-hrow k-g4 k-sm ap-crumb">
            <Icon name="chevronLeft" size={16} />
            All launches
          </Link>
          <div className="k-hrow k-between ap-dtitle">
            <div className="k-hrow k-g16 ap-base">
              <h1 className="k-d k-d96">{project}</h1>
              {version && <span className="k-mono k-muted ap-dversion">{version}</span>}
            </div>
            <div className="k-hrow k-g8">
              <Link className="k-btn" to="/launches/$id/edit" params={params}>
                <Icon name="write" size={18} />
                Edit the text
              </Link>
              {menu}
            </div>
          </div>
          <div className="k-hrow k-g10 ap-mt12">
            <span className="k-pill k-p-wait">Waiting for you</span>
            <span className="k-muted">
              {launch.repo} · drafted <span suppressHydrationWarning>{ago(launch.createdAt, now)}</span> · {TRIGGERS[launch.trigger] ?? `started by ${launch.trigger}`}
            </span>
          </div>
          <div className="ap-dgrid">
            <div className="k-stack k-g20">
              {tabs(true)}
              {tab === 'channels' && (
                <>
                  <div className="ap-dcards">
                    {lines.map((l) => (
                      <ChannelCard key={l.channel} line={l} times={chipsOf(l.channel)} launchId={launch.id} timezone={timezone} now={now} onAnotherDay={() => setAnother(l.channel)} />
                    ))}
                  </div>
                  <p className="k-sm k-muted ap-m0">Times in {timezone}.</p>
                </>
              )}
              {tab === 'content' && (
                <>
                  <span className="k-sm k-muted">
                    {done} of {total} approved
                  </span>
                  <div className="ap-dcards">{contentCards}</div>
                </>
              )}
              {tab === 'search' && search}
              {tab === 'details' && details}
              {tab !== 'content' && notices}
            </div>
            <aside className="k-card k-wait ap-aside" aria-label="Waiting for you">
              <h2 className="k-d k-d48">Waiting for you</h2>
              <p className="ap-m0">Approving records the drafts as they are now: the article goes to the site, then every approved channel at its time.</p>
              <ul className="ap-ticks">
                {ticks.map((p) => {
                  const ok = approved(p);
                  const broken = sched.get(p.id)?.broken;
                  return (
                    <li key={p.id} className="k-hrow k-g8">
                      {ok ? <Icon name="check" size={18} strokeWidth={3} /> : <span className="ap-ring" aria-hidden="true" />}
                      {p.name} · {isAuto(p) ? 'Auto' : ok ? 'approved' : broken ? 'reconnect first' : 'not approved'}
                    </li>
                  );
                })}
              </ul>
              <button type="button" className="k-btn k-blk k-full" disabled={busy} onClick={approve}>
                <Icon name="check" size={18} />
                {busy ? 'Approving…' : cta}
              </button>
              {app ? (
                <Link to="/launches/$id/preview" params={params} className="k-btn k-onyel k-full">
                  <Icon name="eye" size={18} />
                  Preview the article
                </Link>
              ) : (
                previewLink
              )}
            </aside>
          </div>
        </div>
      </div>

      {anotherItem && (
        <ScheduleSheet open onOpenChange={(o) => !o && setAnother(null)} launchId={launch.id} item={anotherItem} name={nameOf(anotherItem.channel)} timezone={timezone} chips={chipsOf(anotherItem.channel).chips} />
      )}
    </div>
  );
}

const TRIGGERS: Record<string, string> = {
  release: 'started by the release',
  manual: 'started by hand',
  public: 'started when the repo went public',
  enabled: 'started when launches were turned on',
  article: 'written in the app',
};

/** What a channel's line says of when it goes out */
function whenWords(line: ChannelLine, timezone: string, now: Date): string {
  if (line.channel === 'blog') {
    const langs = line.piece?.meta.split(' · ')[0];
    return `The article${langs ? `, in ${langs}` : ''} · as soon as you approve`;
  }
  const at = line.sched?.scheduled?.scheduledAt;
  const label = at ? timeLabel(at, timezone, now) : null;
  if (line.sched?.mode === 'auto') return `Goes out ${label ?? 'once the article is live'} on its own`;
  if (!label) return 'As soon as you approve';
  return label;
}

function ChannelRow({ line, times, launchId, timezone, now, open, onOpen, onAnotherDay }: { line: ChannelLine; times: ChannelChips; launchId: number; timezone: string; now: Date; open: boolean; onOpen: () => void; onAnotherDay: () => void }) {
  const { sched } = line;
  const name = nameOf(line.channel);
  const broken = sched?.broken;
  const { chips, reason } = times;
  const at = sched?.scheduled?.scheduledAt;
  const best = chips?.[0];
  const isBest = Boolean(at && best && Date.parse(best.at) === Date.parse(at));
  const words = whenWords(line, timezone, now);
  const expanded = open && sched;
  return (
    <div className="k-row ap-chrow">
      <span className={`k-ic${broken ? ' ap-ic-bad' : ''}`}>
        <Glyph name={line.channel} />
      </span>
      <div className="k-grow k-stack k-g4">
        <div className="k-hrow k-between k-g8">
          <strong>{name}</strong>
          <ModePill line={line} />
        </div>
        <div className="k-sm k-muted">
          {expanded ? (isBest ? `${words}, the best time for this account` : words) : words}
          {sched && !expanded && (
            <>
              {' · '}
              <button type="button" className="ap-link" onClick={onOpen} aria-label={`Change when ${name} goes out`}>
                Change
              </button>
            </>
          )}
        </div>
      </div>
      {expanded && sched && <Times launchId={launchId} item={sched} name={name} timezone={timezone} chips={chips} reason={reason} onAnotherDay={onAnotherDay} />}
      {broken && (
        <div className="ap-indent">
          <BrokenNotice id={broken.id} />
        </div>
      )}
    </div>
  );
}

function ModePill({ line }: { line: ChannelLine }) {
  return line.sched?.mode === 'auto' ? <span className="k-pill k-p-draft">Auto</span> : <span className="k-pill k-p-line">Approval</span>;
}

function BrokenNotice({ id }: { id: number }) {
  return (
    <div className="k-notice k-bad">
      <span className="ap-diamond" aria-hidden="true" />
      <div className="k-grow">
        <strong>The account is not working.</strong> It waits until you{' '}
        <Link to="/channels" search={{ focus: String(id) }}>
          reconnect it
        </Link>
        .
      </div>
    </div>
  );
}

/** A channel on the desktop: a card of its own in the two-column grid */
function ChannelCard({ line, times, launchId, timezone, now, onAnotherDay }: { line: ChannelLine; times: ChannelChips; launchId: number; timezone: string; now: Date; onAnotherDay: () => void }) {
  const { sched } = line;
  const name = nameOf(line.channel);
  const broken = sched?.broken;
  const { chips, reason } = times;
  const at = sched?.scheduled?.scheduledAt;
  const best = chips?.[0];
  const isBest = Boolean(at && best && Date.parse(best.at) === Date.parse(at));
  const words = whenWords(line, timezone, now);
  const [changing, setChanging] = useState(false);
  return (
    <div className={`k-card ap-dcard${broken ? ' k-fail' : ''}`}>
      <div className="k-hrow k-g10">
        <span className={`k-ic${broken ? ' ap-ic-bad' : ''}`}>
          <Glyph name={line.channel} />
        </span>
        <strong className="k-grow">{name}</strong>
        <ModePill line={line} />
      </div>
      <div className="k-sm k-muted">
        {isBest ? `${words}, the best time for this account` : words}
        {sched && sched.mode === 'auto' && !changing && (
          <>
            {' · '}
            <button type="button" className="ap-link" onClick={() => setChanging(true)}>
              Change
            </button>
          </>
        )}
      </div>
      {line.channel === 'blog' && line.piece && <div className="k-sm k-clamp3">{line.piece.excerpt}</div>}
      {sched && !broken && (sched.mode !== 'auto' || changing) && <Times bare launchId={launchId} item={sched} name={name} timezone={timezone} chips={chips} reason={reason} onAnotherDay={onAnotherDay} />}
      {broken && <BrokenNotice id={broken.id} />}
    </div>
  );
}
