import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { ErrorPage, NotFoundPage } from '../components/Problems';
import { SessionExpiry } from '../components/SessionExpiry';
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

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' }, { title: 'Shipcast' }, { name: 'robots', content: 'noindex' }],
    links: [
      { rel: 'icon', href: '/logo/favicon.svg' },
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
    ],
  }),
  shellComponent: Document,
  component: Outlet,
  // Outside the shell (an address no section matches): the same pages, on their own
  notFoundComponent: () => (
    <main className="wrap bare">
      <NotFoundPage />
    </main>
  ),
  errorComponent: (props) => (
    <main className="wrap bare">
      <ErrorPage {...props} />
    </main>
  ),
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
