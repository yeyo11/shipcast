import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { ErrorPage, NotFoundPage } from '../components/Problems';
import { SessionExpiry } from '../components/SessionExpiry';
import accessCss from '../styles/access.css?url';
import appCss from '../styles/app.css?url';
import approveCss from '../styles/approve.css?url';
import channelsCss from '../styles/channels.css?url';
import componentsCss from '../styles/components.css?url';
import featuresCss from '../styles/features.css?url';
import homeCss from '../styles/home.css?url';
import commentsCss from '../styles/comments.css?url';
import kitCss from '../styles/kit.css?url';
import layoutCss from '../styles/layout.css?url';
import publishedCss from '../styles/published.css?url';
import statsCss from '../styles/stats.css?url';
import writeCss from '../styles/write.css?url';
import settingsCss from '../styles/settings.css?url';
import { MANIFEST_COLORS } from '../pwa/manifest';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      // viewport-fit=cover: the page runs under the notch and the home indicator, and the bars keep clear of them with env(safe-area-inset-*) (kit.css)
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { title: 'Shipcast' },
      { name: 'robots', content: 'noindex' },
      // The installed app (docs/decisions/pwa.md): the status bar in the page's ground, and on iOS the app full screen under a translucent one
      { name: 'theme-color', content: MANIFEST_COLORS.theme },
      { name: 'mobile-web-app-capable', content: 'yes' },
      { name: 'apple-mobile-web-app-capable', content: 'yes' },
      { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
      { name: 'apple-mobile-web-app-title', content: 'Shipcast' },
    ],
    links: [
      { rel: 'icon', href: '/logo/favicon.svg' },
      // With the cookies, so a proxy that asks for a sign-in in front of the app still hands the manifest over
      { rel: 'manifest', href: '/manifest.webmanifest', crossOrigin: 'use-credentials' },
      { rel: 'apple-touch-icon', href: '/pwa/apple-touch-icon.png', sizes: '180x180' },
      { rel: 'stylesheet', href: '/tokens.css' },
      { rel: 'stylesheet', href: appCss },
      { rel: 'stylesheet', href: componentsCss },
      { rel: 'stylesheet', href: featuresCss },
      { rel: 'stylesheet', href: layoutCss },
      { rel: 'stylesheet', href: kitCss },
      { rel: 'stylesheet', href: approveCss },
      { rel: 'stylesheet', href: homeCss },
      { rel: 'stylesheet', href: publishedCss },
      { rel: 'stylesheet', href: channelsCss },
      { rel: 'stylesheet', href: commentsCss },
      { rel: 'stylesheet', href: statsCss },
      { rel: 'stylesheet', href: writeCss },
      { rel: 'stylesheet', href: settingsCss },
      { rel: 'stylesheet', href: accessCss },
    ],
  }),
  shellComponent: Document,
  component: Outlet,
  // Outside the shell (an address no section matches): the same pages, on their own
  notFoundComponent: () => <NotFoundPage place="bare" />,
  errorComponent: (props) => <ErrorPage {...props} place="bare" />,
});

function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {/* Isolated (components.css), so Base UI's portals at the end of the body (dialogs, menus, toasts) always sit above the app */}
        <div className="app-root">{children}</div>
        <SessionExpiry />
        <Scripts />
      </body>
    </html>
  );
}
