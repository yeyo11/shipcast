import { createFileRoute, Link, Outlet, redirect, useNavigate, useRouterState } from '@tanstack/react-router';
import { useRef, useState, type ReactNode } from 'react';
import { AttentionBell } from '../components/AttentionBell';
import { ErrorPage, NotFoundPage } from '../components/Problems';
import { SmoothScroll } from '../components/SmoothScroll';
import { requestTour } from '../components/tour/request';
import { TourHost } from '../components/tour/TourHost';
import { ToastProvider } from '../components/Toasts';
import { Avatar } from '../components/ui';
import { CommandPalette, useShortcutLabel } from '../components/ui/CommandPalette';
import { Drawer, DrawerClose } from '../components/ui/Drawer';
import { ChannelsIcon, LaunchesIcon, MoreIcon, SearchIcon, StatsIcon, WriteIcon } from '../components/ui/icons';
import { Menu } from '../components/ui/Menu';
import { Tooltip, TooltipProvider } from '../components/ui/Tooltip';
import { getOnboardingState } from '../server/onboarding.functions';
import { currentSettingsPage, inSettings } from '../server/settings-pages';
import { whoAmI } from '../server/session.functions';

export const Route = createFileRoute('/_app')({
  loader: async () => {
    const [who, onboarding] = await Promise.all([whoAmI(), getOnboardingState()]);
    // A new install opens on the onboarding until it is finished or set aside; an install already working never does
    if (onboarding.autoOpen) throw redirect({ to: '/onboarding' });
    return who;
  },
  component: Shell,
  notFoundComponent: NotFoundPage,
  errorComponent: ErrorPage,
});

type To = '/' | '/write' | '/channels' | '/comments' | '/stats' | '/settings' | '/settings/ai' | '/settings/automation' | '/settings/api' | '/launch';

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
const COMMENTS: Section = { to: '/comments', label: 'Comments', match: (p) => p.startsWith('/comments') };
const STATS: Section = { to: '/stats', label: 'Stats', icon: StatsIcon, match: (p) => p.startsWith('/stats') };
const SETTINGS: Section = { to: '/settings', label: 'General', match: (p) => currentSettingsPage(p) === '/settings' };
const AI: Section = { to: '/settings/ai', label: 'AI', match: (p) => currentSettingsPage(p) === '/settings/ai' };
const AUTOMATION: Section = { to: '/settings/automation', label: 'Automation', match: (p) => currentSettingsPage(p) === '/settings/automation' };
const API: Section = { to: '/settings/api', label: 'API', match: (p) => currentSettingsPage(p) === '/settings/api' };

/** Wide screens: the five working sections in the top bar; the configuration is in the user menu */
const TOP = [LAUNCHES, WRITE, CHANNELS, COMMENTS, STATS];
/** Phones: the four in reach of the thumb; the rest behind More */
const BOTTOM = [LAUNCHES, WRITE, CHANNELS, STATS];
/** Settings is one group of four, in the user menu (a submenu) and in More (a group), never four flat entries */
const SETTINGS_GROUP = [SETTINGS, AI, AUTOMATION, API];
const MORE = [COMMENTS, ...SETTINGS_GROUP];

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
  const settingsHere = inSettings(path);

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
              <Tooltip content={`Search (${shortcut})`} side="bottom">
                <button type="button" className="ui-icon-button search-button" aria-label="Search" onClick={() => setPalette(true)} aria-keyshortcuts="Meta+K Control+K">
                  <SearchIcon />
                </button>
              </Tooltip>
              <AttentionBell />
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
                    {
                      kind: 'submenu',
                      label: 'Settings',
                      current: settingsHere,
                      entries: SETTINGS_GROUP.map((s) => ({ label: s.label, current: s.match(path), onSelect: () => void navigate({ to: s.to }) })),
                    },
                    { kind: 'separator' },
                    { label: 'Take the tour', onSelect: requestTour },
                    { label: 'Sign out', onSelect: () => signOut.current?.requestSubmit() },
                  ]}
                />
                <form ref={signOut} method="post" action="/auth/logout" hidden />
              </div>
            </div>
          </div>
        </header>
        <main id="main" className="wrap" tabIndex={-1} data-path={path}>
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
                <li>
                  <DrawerClose render={<Link to={COMMENTS.to} aria-current={current(COMMENTS)} />}>{COMMENTS.label}</DrawerClose>
                </li>
                <li>
                  <DrawerClose render={<Link to="/launch" aria-current={path === '/launch' ? 'page' : undefined} />}>Launch a repo</DrawerClose>
                </li>
                <li role="group" aria-labelledby="more-settings" className="drawer-group" data-current={settingsHere ? '' : undefined}>
                  <span id="more-settings" className="drawer-group-title">
                    {settingsHere && <span className="ui-option-dot" aria-hidden="true" />}
                    Settings
                    {settingsHere && <span className="visually-hidden">, the current section</span>}
                  </span>
                  <ul className="drawer-sublinks">
                    {SETTINGS_GROUP.map((s) => (
                      <li key={s.to}>
                        <DrawerClose render={<Link to={s.to} aria-current={current(s)} />}>{s.label}</DrawerClose>
                      </li>
                    ))}
                  </ul>
                </li>
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
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      setMore(false);
                      requestTour();
                    }}
                  >
                    Take the tour
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
        <TourHost />
      </TooltipProvider>
    </ToastProvider>
  );
}
