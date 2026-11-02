/*
 * The page the service worker shows when a page cannot be reached (docs/decisions/pwa.md): the app's
 * own Offline page (board Offline) as static HTML, on the kit's stylesheets, so it needs nothing the
 * network would have to bring. It tries again on its own once the browser is back online. Built by the
 * PWA plugin (apps/web/pwa-plugin.ts) with the build's hashed stylesheets, and precached with them.
 */

export interface OfflinePageInput {
  /** The stylesheets to link: the tokens, and the build's kit, app and problem-page sheets */
  stylesheets: readonly string[];
  /** The Offline scene as inline SVG (design/pwa/offline.svg), which reads the tokens' colours */
  scene: string;
  themeColor: string;
}

const attr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function offlinePage(input: OfflinePageInput): string {
  const links = input.stylesheets.map((href) => `<link rel="stylesheet" href="${attr(href)}">`).join('\n    ');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="${attr(input.themeColor)}">
    <meta name="robots" content="noindex">
    <title>You're offline · Shipcast</title>
    <link rel="icon" href="/logo/favicon.svg">
    ${links}
  </head>
  <body>
    <div class="app-root">
      <main id="main" class="acc-problem-main" tabindex="-1">
        <header class="k-topbar acc-problem-bare-bar">
          <a href="/" class="k-topbar-brand" aria-label="Shipcast, the launches">
            <span class="k-mark" aria-hidden="true"><span></span></span>
            <span class="k-d acc-problem-brand">Shipcast</span>
          </a>
        </header>
        <section class="k-px k-stack k-g16 acc-problem" aria-labelledby="problem-title" role="alert">
          <div class="acc-problem-art">${input.scene}</div>
          <h1 id="problem-title" class="k-d k-d48">You're offline</h1>
          <p class="k-muted acc-problem-lead">This device is offline, or Shipcast is not reachable. The page opens on its own as soon as the connection is back.</p>
          <div class="k-stack k-g10 acc-problem-actions">
            <button type="button" class="k-btn k-pri k-full" id="retry">Try again</button>
          </div>
        </section>
      </main>
    </div>
    <script>
      // The page that was asked for is this one's own address: the worker answered it with this page
      const retry = () => location.reload();
      document.getElementById('retry').addEventListener('click', retry);
      addEventListener('online', retry);
    </script>
  </body>
</html>
`;
}
