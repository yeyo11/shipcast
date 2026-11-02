/*
 * The web app manifest (docs/decisions/pwa.md): what makes Shipcast installable, served as
 * /manifest.webmanifest by the PWA plugin (apps/web/pwa-plugin.ts). The colours are the design
 * tokens' night ground, the app's default theme (design/tokens.css): the splash screen and the
 * status bar match the page that follows them.
 */

export const MANIFEST_COLORS = {
  /** --sc-ground, night */
  background: '#141413',
  theme: '#141413',
} as const;

export interface WebManifest {
  id: string;
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: 'standalone';
  orientation: 'any';
  theme_color: string;
  background_color: string;
  categories: string[];
  icons: Array<{ src: string; sizes: string; type: 'image/png'; purpose: 'any' | 'maskable' }>;
  shortcuts: Array<{ name: string; short_name: string; url: string; icons: Array<{ src: string; sizes: string; type: 'image/png' }> }>;
}

/** The phone's bottom bar, as shortcuts on the installed icon's long press */
const SHORTCUTS = [
  { name: 'Launches', url: '/launches' },
  { name: 'Write', url: '/write' },
  { name: 'Comments', url: '/comments' },
  { name: 'Stats', url: '/stats' },
];

export function webManifest(): WebManifest {
  return {
    id: '/',
    name: 'Shipcast',
    short_name: 'Shipcast',
    description: 'Launch your GitHub projects: drafts for every channel, reviewed and published once.',
    // The launches, as the shortcut names them; `/launches` sends to the list at `/`
    start_url: '/launches',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    theme_color: MANIFEST_COLORS.theme,
    background_color: MANIFEST_COLORS.background,
    categories: ['productivity', 'developer'],
    icons: [
      { src: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/pwa/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/pwa/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: SHORTCUTS.map((s) => ({ name: s.name, short_name: s.name, url: s.url, icons: [{ src: '/pwa/maskable-192.png', sizes: '192x192', type: 'image/png' }] })),
  };
}
