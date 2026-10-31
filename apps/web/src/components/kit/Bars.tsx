import { Link, useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { badgeText, useShell } from './shell';

/*
 * The bars every screen stands between (boards TopBar, BottomBar and the desktop header): on a phone a
 * top bar with the mark (or a way back) and the bottom bar of the five sections; from 960 px one
 * header with the sections, the search field, the bell and the owner.
 */

type SectionTo = '/' | '/write' | '/comments' | '/stats' | '/channels';

interface Section {
  id: 'launches' | 'write' | 'comments' | 'stats' | 'channels';
  to: SectionTo;
  label: string;
  icon: IconName;
  match: (path: string) => boolean;
}

const LAUNCHES: Section = { id: 'launches', to: '/', label: 'Launches', icon: 'launches', match: (p) => p === '/' || p === '/launch' || p.startsWith('/launches/') || p === '/sources' };
const WRITE: Section = { id: 'write', to: '/write', label: 'Write', icon: 'write', match: (p) => p === '/write' };
const COMMENTS: Section = { id: 'comments', to: '/comments', label: 'Comments', icon: 'comments', match: (p) => p.startsWith('/comments') };
const STATS: Section = { id: 'stats', to: '/stats', label: 'Stats', icon: 'stats', match: (p) => p.startsWith('/stats') };
const CHANNELS: Section = { id: 'channels', to: '/channels', label: 'Channels', icon: 'channels', match: (p) => p.startsWith('/channels') };

/** Phones: four sections and More (Channels and the settings live in More) */
const BOTTOM = [LAUNCHES, WRITE, COMMENTS, STATS];
/** Desktops: the five working sections; settings are behind the owner's menu */
const DESKTOP = [LAUNCHES, WRITE, COMMENTS, CHANNELS, STATS];

const EXACT = { exact: true } as const;

function usePath() {
  return useRouterState({ select: (s) => s.location.pathname });
}

/** Shipcast's mark: the yellow tile with its stamp and the black dot */
export function Mark() {
  return (
    <span className="k-mark" aria-hidden="true">
      <span />
    </span>
  );
}

function Bell({ className }: { className: string }) {
  const { attention, setNotificationsOpen } = useShell();
  const count = attention?.count ?? 0;
  return (
    <button type="button" className={className} aria-label={count > 0 ? `What needs you, ${count}` : 'What needs you, nothing'} onClick={() => setNotificationsOpen(true)}>
      <Icon name="bell" />
      {count > 0 && (
        <span className="k-badge" aria-hidden="true">
          {badgeText(count)}
        </span>
      )}
    </button>
  );
}

export interface TopBarProps {
  /** A way back instead of the mark: its words and where it goes, or `more` to open the More sheet */
  back?: { label: string; to: string; search?: Record<string, unknown> } | { label: string; more: true };
  /** What the bar carries on its right instead of search and the bell (an editor's Save, a sheet's Close) */
  actions?: ReactNode;
}

/** A phone's top bar (board TopBar): hidden from 960 px, where the desktop header takes over */
export function TopBar({ back, actions }: TopBarProps) {
  const { setPaletteOpen, setMoreOpen } = useShell();
  return (
    <header className="k-topbar">
      {back && 'more' in back ? (
        <button type="button" className="k-topbar-back" onClick={() => setMoreOpen(true)}>
          <Icon name="chevronLeft" />
          {back.label}
        </button>
      ) : back ? (
        <Link to={back.to} search={back.search} className="k-topbar-back">
          <Icon name="chevronLeft" />
          {back.label}
        </Link>
      ) : (
        <Link to="/" className="k-topbar-brand" aria-label="Shipcast, the launches" activeOptions={EXACT}>
          <Mark />
          <span className="k-d" style={{ fontSize: 24 }}>
            Shipcast
          </span>
        </Link>
      )}
      <div className="k-topbar-tools">
        {actions ?? (
          <>
            <button type="button" className="k-topbar-tool" aria-label="Search" onClick={() => setPaletteOpen(true)} aria-keyshortcuts="Meta+K Control+K">
              <Icon name="search" />
            </button>
            <Bell className="k-topbar-tool k-topbar-bell" />
          </>
        )}
      </div>
    </header>
  );
}

/** A phone's bottom bar (board BottomBar): Launches, Write, Comments, Stats and More */
export function BottomBar() {
  const path = usePath();
  const { commentsWaiting, moreOpen, setMoreOpen } = useShell();
  const inMore = path.startsWith('/channels') || path.startsWith('/settings') || path === '/more';
  return (
    <nav className="k-bottombar" aria-label="Sections">
      {BOTTOM.map((s) => {
        // While More is open it is where the owner is: one section marked at a time
        const on = s.match(path) && !moreOpen;
        const badge = s.id === 'comments' && commentsWaiting > 0 ? badgeText(commentsWaiting) : null;
        return (
          // The router marks an active link current on its own: both states are set here, so More open wins
          <Link key={s.id} to={s.to} activeProps={{ 'aria-current': on ? 'page' : undefined }} inactiveProps={{ 'aria-current': on ? 'page' : undefined }} data-on={on ? '' : undefined} activeOptions={EXACT} className="k-bottombar-item">
            <span className="k-bottombar-chip">
              <Icon name={s.icon} size={22} />
            </span>
            {badge && (
              <span className="k-badge k-bottombar-badge" aria-label={`${commentsWaiting} waiting`}>
                {badge}
              </span>
            )}
            {s.label}
          </Link>
        );
      })}
      <button type="button" className="k-bottombar-item" data-on={moreOpen || inMore ? '' : undefined} aria-current={moreOpen || inMore ? 'page' : undefined} aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
        <span className="k-bottombar-chip">
          <Icon name="menu" size={22} />
        </span>
        More
      </button>
    </nav>
  );
}

export interface DesktopHeaderProps {
  /** The owner's menu: the avatar button and what it opens */
  owner: ReactNode;
}

/** The desktop header (boards Desktop*): the mark, the sections, search, the bell and the owner */
export function DesktopHeader({ owner }: DesktopHeaderProps) {
  const path = usePath();
  const { commentsWaiting, setPaletteOpen } = useShell();
  return (
    <header className="k-dheader">
      <div className="k-dheader-inner">
        <Link to="/" className="k-hrow k-g10 k-dheader-brand" aria-label="Shipcast, the launches" activeOptions={EXACT}>
          <Mark />
          <span className="k-d" style={{ fontSize: 26 }}>
            Shipcast
          </span>
        </Link>
        <nav className="k-nav k-hrow k-g4 k-grow" aria-label="Sections">
          {DESKTOP.map((s) => {
            const on = s.match(path);
            return (
              <Link key={s.id} to={s.to} className={on ? 'k-on' : undefined} aria-current={on ? 'page' : undefined} activeOptions={EXACT}>
                <Icon name={s.icon} size={18} />
                {s.label}
                {s.id === 'comments' && commentsWaiting > 0 && <span className="k-badge">{badgeText(commentsWaiting)}</span>}
              </Link>
            );
          })}
        </nav>
        <button type="button" className="k-input k-ph k-dheader-search" onClick={() => setPaletteOpen(true)} aria-keyshortcuts="Meta+K Control+K">
          <Icon name="search" size={18} />
          <span className="k-grow k-sm">Go to or do…</span>
          <span className="k-kbd">⌘K</span>
        </button>
        <Bell className="k-btn k-icon k-dheader-bell" />
        {owner}
      </div>
    </header>
  );
}
