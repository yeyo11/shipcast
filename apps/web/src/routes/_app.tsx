import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useRef, useState, type ReactNode } from 'react';
import { ErrorPage, NotFoundPage } from '../components/Problems';
import { SmoothScroll } from '../components/SmoothScroll';
import { ToastProvider } from '../components/Toasts';
import { Avatar } from '../components/ui';
import { CommandPalette, useShortcutLabel } from '../components/ui/CommandPalette';
import { Drawer, DrawerClose } from '../components/ui/Drawer';
import { ChannelsIcon, LaunchesIcon, MoreIcon, SearchIcon, StatsIcon, WriteIcon } from '../components/ui/icons';
import { Menu } from '../components/ui/Menu';
import { Tooltip, TooltipProvider } from '../components/ui/Tooltip';
import { whoAmI } from '../server/session.functions';

export const Route = createFileRoute('/_app')({
  loader: () => whoAmI(),
  component: Shell,
  notFoundComponent: NotFoundPage,
  errorComponent: ErrorPage,
});

type To = '/' | '/write' | '/channels' | '/stats' | '/automation' | '/ai' | '/tokens' | '/settings' | '/launch';

interface Section {
  to: To;
  label: string;
  icon?: (props: { size?: number }) => ReactNode;
  /** The paths that belong to it, so a launch's page still marks Launches as where you are */
  match: (path: string) => boolean;
}

const LAUNCHES: Section = { to: '/', label: 'Launches', icon: LaunchesIcon, match: (p) => p === '/' || p === '/launch' || p.startsWith('/launches/') };
const WRITE: Section = { to: '/write', label: 'Write', icon: WriteIcon, match: (p) => p === '/write' };
const CHANNELS: Section = { to: '/channels', label: 'Channels', icon: ChannelsIcon, match: (p) => p.startsWith('/channels') };
const STATS: Section = { to: '/stats', label: 'Stats', icon: StatsIcon, match: (p) => p.startsWith('/stats') };
const AUTOMATION: Section = { to: '/automation', label: 'Automation', match: (p) => p.startsWith('/automation') };
const AI: Section = { to: '/ai', label: 'AI', match: (p) => p.startsWith('/ai') };
const API: Section = { to: '/tokens', label: 'API', match: (p) => p.startsWith('/tokens') };
const SETTINGS: Section = { to: '/settings', label: 'Settings', match: (p) => p.startsWith('/settings') };

/** Wide screens: every section in the top bar */
const TOP = [LAUNCHES, WRITE, CHANNELS, STATS, AUTOMATION, AI, API];
/** Phones: the four in reach of the thumb; the rest behind More */
const BOTTOM = [LAUNCHES, WRITE, CHANNELS, STATS];
const MORE = [AUTOMATION, AI, API, SETTINGS];

function SignOutForm({ className = 'btn btn-small' }: { className?: string }) {
  return (
    <form method="post" action="/auth/logout">
      <button className={className} type="submit">
        Sign out
      </button>
    </form>
  );
}

function Shell() {
  const { login, name, avatarUrl } = Route.useLoaderData();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [palette, setPalette] = useState(false);
  const [more, setMore] = useState(false);
  const signOut = useRef<HTMLFormElement>(null);
  const shortcut = useShortcutLabel();
  const navigate = useNavigate();
  const current = (s: Section) => (s.match(path) ? ('page' as const) : undefined);
  const inMore = MORE.some((s) => s.match(path));

  return (
    <ToastProvider>
      <TooltipProvider>
        <SmoothScroll />
        <a className="skip" href="#main">
          Skip to the content
        </a>
        <header className="top">
          <div className="top-inner wrap">
            <Link to="/" className="lockup" aria-label="Shipcast, the launches">
              <img src="/logo/mark.svg" alt="" />
              <span>Shipcast</span>
            </Link>
            <nav className="nav" aria-label="Sections">
              {TOP.map((s) => (
                <Link key={s.to} to={s.to} aria-current={current(s)}>
                  {s.label}
                </Link>
              ))}
            </nav>
            <div className="top-tools">
              <Tooltip content={`Go to or do anything (${shortcut})`} side="bottom">
                <button type="button" className="search-button" onClick={() => setPalette(true)} aria-keyshortcuts="Meta+K Control+K">
                  <SearchIcon />
                  <span className="search-label">Search</span>
                  <kbd className="ui-kbd search-kbd" aria-hidden="true">{shortcut}</kbd>
                </button>
              </Tooltip>
              <div className="who-menu">
                <Menu
                  trigger={
                    <button type="button" className="who" aria-label={`Signed in as @${login}`}>
                      <Avatar src={avatarUrl} alt="" size={30} />
                      <span>@{login}</span>
                    </button>
                  }
                  entries={[
                    { kind: 'note', label: name ? `${name} (@${login})` : `@${login}` },
                    { kind: 'separator' },
                    { label: 'Settings', onSelect: () => void navigate({ to: '/settings' }) },
                    { label: 'Sign out', onSelect: () => signOut.current?.requestSubmit() },
                  ]}
                />
                <form ref={signOut} method="post" action="/auth/logout" hidden />
              </div>
            </div>
          </div>
        </header>
        <main id="main" className="wrap" tabIndex={-1}>
          <Outlet />
        </main>
        <nav className="bottom-bar" aria-label="Sections">
          {BOTTOM.map((s) => {
            const Icon = s.icon!;
            return (
              <Link key={s.to} to={s.to} aria-current={current(s)}>
                <Icon size={22} />
                <span>{s.label}</span>
              </Link>
            );
          })}
          <Drawer
            title="More"
            open={more}
            onOpenChange={setMore}
            trigger={
              <button type="button" data-current={inMore ? '' : undefined} aria-label={inMore ? 'More, current section inside' : 'More'}>
                <MoreIcon size={22} />
                <span>More</span>
              </button>
            }
          >
            <nav aria-label="More sections">
              <ul className="drawer-links">
                {[...MORE, { ...LAUNCHES, to: '/launch' as const, label: 'Launch a repo', match: (p: string) => p === '/launch' }].map((s) => (
                  <li key={s.to}>
                    <DrawerClose render={<Link to={s.to} aria-current={current(s)} />}>{s.label}</DrawerClose>
                  </li>
                ))}
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      setMore(false);
                      setPalette(true);
                    }}
                  >
                    Search sections and actions
                  </button>
                </li>
              </ul>
            </nav>
            <div className="drawer-who">
              <span className="account-who">
                <Avatar src={avatarUrl} alt="" size={36} />
                <span>
                  <strong>@{login}</strong>
                  {name && <span className="muted"> · {name}</span>}
                </span>
              </span>
              <SignOutForm />
            </div>
          </Drawer>
        </nav>
        <CommandPalette open={palette} onOpenChange={setPalette} />
      </TooltipProvider>
    </ToastProvider>
  );
}
