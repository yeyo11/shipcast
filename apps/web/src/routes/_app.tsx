import { createFileRoute, Outlet, redirect, useNavigate, useRouterState } from '@tanstack/react-router';
import { useRef, type ReactNode } from 'react';
import { BannerProvider } from '../components/BannerState';
import { BottomBar, DesktopHeader } from '../components/kit/Bars';
import { Icon } from '../components/kit/Icon';
import { MoreSheet, OwnerAvatar, type Owner } from '../components/kit/MoreSheet';
import { ShellProvider, useShell } from '../components/kit/shell';
import { LiveProvider, LiveStatusNote } from '../components/live/Live';
import { Notifications } from '../components/Notifications';
import { ErrorPage, NotFoundPage } from '../components/Problems';
import { SmoothScroll } from '../components/SmoothScroll';
import { requestTour } from '../components/tour/request';
import { TourHost } from '../components/tour/TourHost';
import { WebMcpHost } from '../components/WebMcpHost';
import { ToastProvider } from '../components/Toasts';
import { CommandPalette } from '../components/ui/CommandPalette';
import { Menu } from '../components/ui/Menu';
import { TooltipProvider } from '../components/ui/Tooltip';
import { getBanner } from '../server/banner.functions';
import { getOnboardingState } from '../server/onboarding.functions';
import { currentSettingsPage, inSettings } from '../server/settings-pages';
import { whoAmI } from '../server/session.functions';
import { getWebMcp } from '../server/webmcp.functions';

export const Route = createFileRoute('/_app')({
  loader: async () => {
    const [who, onboarding, banner, webMcp] = await Promise.all([whoAmI(), getOnboardingState(), getBanner(), getWebMcp()]);
    // A new install opens on the onboarding until it is finished or set aside; an install already working never does
    if (onboarding.autoOpen) throw redirect({ to: '/onboarding' });
    return { ...who, banner, webMcp: webMcp.enabled };
  },
  component: Shell,
  // A section's failure takes the shell with it (no section has its own boundary): the page draws the bars itself
  notFoundComponent: () => <NotFoundPage place="app" />,
  errorComponent: (props) => <ErrorPage {...props} place="app" />,
});

/** Settings is one group of four, behind the owner's menu on a desktop */
const SETTINGS_GROUP = [
  { to: '/settings', label: 'General' },
  { to: '/settings/ai', label: 'AI' },
  { to: '/settings/automation', label: 'Automation' },
  { to: '/settings/api', label: 'API' },
] as const;

function Shell() {
  const { login, name, avatarUrl, banner, webMcp, live } = Route.useLoaderData();
  const owner = { login, name, avatarUrl };
  return (
    <LiveProvider enabled={live}>
      <ShellProvider>
        <ToastProvider>
          <TooltipProvider>
            <SmoothScroll />
            <a className="skip" href="#main">
              Skip to the content
            </a>
            <div className="k-desktop">
              <DesktopHeader owner={<OwnerMenu owner={owner} />} />
            </div>
            <ShellMain>
              <LiveStatusNote />
              <BannerProvider initial={banner}>
                <Outlet />
              </BannerProvider>
            </ShellMain>
            <BottomBar />
            <MoreSheet owner={owner} />
            <Notifications />
            <Palette />
            <TourHost />
            <WebMcpHost enabled={webMcp} />
          </TooltipProvider>
        </ToastProvider>
      </ShellProvider>
    </LiveProvider>
  );
}

function ShellMain({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <main id="main" className="k-main" tabIndex={-1} data-path={path}>
      {children}
    </main>
  );
}

function Palette() {
  const { paletteOpen, setPaletteOpen } = useShell();
  return <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />;
}

/** The desktop header's owner button: the settings, the tour and signing out */
function OwnerMenu({ owner }: { owner: Owner }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const signOut = useRef<HTMLFormElement>(null);
  return (
    <>
      <Menu
        trigger={
          <button type="button" className="k-btn k-sm k-owner" aria-label={`Signed in as @${owner.login}`}>
            <OwnerAvatar owner={owner} />
            <Icon name="chevronDown" size={16} />
          </button>
        }
        entries={[
          { kind: 'note', label: owner.name ? `${owner.name} (@${owner.login})` : `@${owner.login}` },
          { kind: 'separator' },
          {
            kind: 'submenu',
            label: 'Settings',
            current: inSettings(path),
            entries: SETTINGS_GROUP.map((s) => ({ label: s.label, current: currentSettingsPage(path) === s.to, onSelect: () => void navigate({ to: s.to }) })),
          },
          { kind: 'separator' },
          { label: 'Take the tour', onSelect: requestTour },
          { label: 'Sign out', onSelect: () => signOut.current?.requestSubmit() },
        ]}
      />
      <form ref={signOut} method="post" action="/auth/logout" hidden />
    </>
  );
}
