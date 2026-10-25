import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { consoleLinks, signInPath } from './src/server/console-links.ts';

// The engine and its packages run as they are, through Node's own TypeScript support, as they do for
// the CLI: bundling them would mean bundling native and wasm renderers too
const WORKSPACE = ['@shipcast/engine', '@shipcast/runtime', '@shipcast/connectors', '@shipcast/schema', '@shipcast/assets', '@shipcast/mcp'];
/** Never pre-bundled for the browser: native renderers the engine loads on the server */
const NATIVE = ['@resvg/resvg-js', 'satori'];
/**
 * With discovery off, development would serve Base UI unbundled, and its CommonJS dependency
 * (use-sync-external-store) cannot load in the browser that way: its entry points are pre-bundled.
 * Add one here when a page starts using another Base UI component.
 */
const BASE_UI = ['alert-dialog', 'autocomplete', 'combobox', 'dialog', 'drawer', 'menu', 'popover', 'select', 'tabs', 'toast', 'tooltip'].map((c) => `@base-ui/react/${c}`);

/**
 * Discovery would crawl from the routes into the engine's source (a linked package) and try to
 * pre-bundle its native renderers for the browser. Start sets the client's dependency options itself,
 * so this runs after it; the browser only needs what Start already lists.
 */
const serverOnlyDeps = (): Plugin => ({
  name: 'shipcast-server-only-deps',
  enforce: 'post',
  configEnvironment(name) {
    if (name === 'client') return { optimizeDeps: { noDiscovery: true, include: BASE_UI, exclude: [...WORKSPACE, ...NATIVE] } };
    return undefined;
  },
});

/** In development, a sign-in link in the terminal: GitHub only calls back to the real address */
const printSignInLink = (): Plugin => ({
  name: 'shipcast-sign-in-link',
  configureServer(server) {
    server.httpServer?.once('listening', () => {
      const address = server.resolvedUrls?.local[0] ?? 'http://localhost:3000/';
      console.log(`\n  Sign in: ${address.replace(/\/$/, '')}${signInPath(consoleLinks().create())}\n`);
    });
  },
});

export default defineConfig({
  server: { port: 3000, host: '127.0.0.1' },
  // The design system's folder is the app's public folder: tokens, fonts, logo and icons, one copy
  publicDir: '../../design',
  environments: {
    ssr: {
      resolve: { external: WORKSPACE },
      optimizeDeps: { exclude: [...WORKSPACE, ...NATIVE], noDiscovery: true },
      build: { rollupOptions: { external: (id: string) => WORKSPACE.some((p) => id === p || id.startsWith(`${p}/`)) } },
    },
  },
  plugins: [tanstackStart(), viteReact(), serverOnlyDeps(), printSignInLink()],
});
