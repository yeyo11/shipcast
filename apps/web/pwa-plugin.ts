import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'vite';
import { MANIFEST_COLORS, webManifest } from './src/pwa/manifest.ts';
import { offlinePage } from './src/pwa/offline-page.ts';

/*
 * The installable app's files (docs/decisions/pwa.md), made with the client build rather than by a
 * PWA framework: /manifest.webmanifest, /offline.html and /sw.js. The worker is src/pwa/sw.ts,
 * bundled on its own once the client build is written, with the list of files to precache and a
 * version made from their contents, so each deploy's worker differs from the last exactly when the
 * files do. In development the manifest and the offline page are served, and no worker is.
 */

const DESIGN = fileURLToPath(new URL('../../design/', import.meta.url));
const SW_ENTRY = fileURLToPath(new URL('./src/pwa/sw.ts', import.meta.url));

/** The design folder's files the installed app and the offline page need, as paths under it */
function publicFiles(): string[] {
  const under = (dir: string, keep: RegExp) =>
    readdirSync(join(DESIGN, dir))
      .filter((name) => keep.test(name))
      .map((name) => `${dir}/${name}`);
  return ['tokens.css', 'logo/favicon.svg', 'logo/mark.svg', ...under('fonts', /\.woff2$/), ...under('pwa', /\.png$/)].sort();
}

/** The Offline scene, inline so it takes the tokens' colours */
const scene = () => readFileSync(join(DESIGN, 'pwa/offline.svg'), 'utf8').trim();

/** The sheets the bare problem page is drawn with, in the root document's order */
const OFFLINE_SHEETS = ['app', 'components', 'layout', 'kit', 'access'];

const manifestJson = () => `${JSON.stringify(webManifest(), null, 2)}\n`;

/** Development: the manifest and the offline page at their addresses; the worker only exists in a build */
function pwaDev(): Plugin {
  return {
    name: 'shipcast-pwa-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? '').split('?')[0];
        if (path === '/manifest.webmanifest') {
          response.setHeader('content-type', 'application/manifest+json');
          response.end(manifestJson());
          return;
        }
        if (path === '/offline.html') {
          response.setHeader('content-type', 'text/html; charset=utf-8');
          response.end(offlinePage({ stylesheets: ['/tokens.css', ...OFFLINE_SHEETS.map((s) => `/src/styles/${s}.css`)], scene: scene(), themeColor: MANIFEST_COLORS.theme }));
          return;
        }
        next();
      });
    },
  };
}

/** The build: the manifest and offline page emitted with the client's files, then the worker over all of them */
function pwaBuild(): Plugin {
  let assets: string[] = [];
  let offline = '';
  return {
    name: 'shipcast-pwa-build',
    apply: 'build',
    applyToEnvironment: (environment) => environment.name === 'client',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle);
      const sheet = (name: string) => {
        const file = files.find((f) => new RegExp(`^assets/${name}-[\\w-]+\\.css$`).test(f));
        if (!file) this.error(`the offline page needs ${name}.css, which the client build no longer emits`);
        return `/${file}`;
      };
      offline = offlinePage({ stylesheets: ['/tokens.css', ...OFFLINE_SHEETS.map(sheet)], scene: scene(), themeColor: MANIFEST_COLORS.theme });
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: manifestJson() });
      this.emitFile({ type: 'asset', fileName: 'offline.html', source: offline });
      assets = files.filter((f) => f.startsWith('assets/')).sort();
    },
    async writeBundle(options) {
      const outDir = options.dir;
      if (!outDir) this.error('the client build has no output folder for the service worker');
      const design = publicFiles();
      const precache = ['/offline.html', ...design.map((f) => `/${f}`), ...assets.map((f) => `/${f}`)];
      // Hashed names stand for their contents; the rest is hashed here, so a changed font or icon is a new version too
      const version = createHash('sha256');
      for (const path of precache) version.update(path);
      for (const file of design) version.update(readFileSync(join(DESIGN, file)));
      version.update(offline);
      version.update(readFileSync(SW_ENTRY));
      await build({
        configFile: false,
        logLevel: 'warn',
        publicDir: false,
        define: { __SW_VERSION__: JSON.stringify(version.digest('hex').slice(0, 16)), __SW_PRECACHE__: JSON.stringify(precache) },
        build: {
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          minify: true,
          sourcemap: false,
          // A classic worker: module workers are not in every browser the app is installed on
          lib: { entry: SW_ENTRY, formats: ['iife'], name: 'shipcastWorker', fileName: () => 'sw.js' },
        },
      });
      console.log(`  service worker: ${precache.length} files precached (${relative(process.cwd(), join(outDir, 'sw.js')).split(sep).join('/')})`);
    },
  };
}

export const pwa = (): Plugin[] => [pwaDev(), pwaBuild()];
