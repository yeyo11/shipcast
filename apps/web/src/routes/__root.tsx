import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import appCss from '../styles/app.css?url';

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: 'Shipcast' }, { name: 'robots', content: 'noindex' }],
    links: [
      { rel: 'icon', href: '/logo/favicon.svg' },
      { rel: 'stylesheet', href: '/tokens.css' },
      { rel: 'stylesheet', href: appCss },
    ],
  }),
  shellComponent: Document,
  component: Outlet,
  notFoundComponent: () => (
    <main className="wrap">
      <h1 className="ph">Not here</h1>
      <p className="muted">
        Nothing lives at this address. <a href="/">Back to the launches</a>
      </p>
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
        {children}
        <Scripts />
      </body>
    </html>
  );
}
