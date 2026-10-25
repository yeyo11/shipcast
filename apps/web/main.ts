import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { ConfigError, KeychainStore, loadAppConfig, loadConfig } from '@shipcast/runtime';
import { serve } from './server.ts';
import { consoleLinks, signInPath } from './src/server/console-links.ts';
import { ensureCertificate } from './tls.ts';

/**
 * `pnpm app`: the built app on the owner's domain. With a Cloudflare token it serves HTTPS on
 * 127.0.0.1 and asks Tailscale Serve to forward the tailnet's port 443 to it, so the domain (whose
 * DNS record points at this machine's tailnet address) reaches it from the owner's devices only.
 * Without the token it serves plain HTTP on localhost, for trying it on this machine.
 */

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '../..');

async function main(): Promise<void> {
  const config = loadConfig(process.env, ROOT);
  const app = loadAppConfig(process.env);
  const secrets = new KeychainStore();
  const domain = new URL(app.publicUrl).host;

  if (!app.tlsCloudflareToken) {
    const port = app.port;
    await serve({ host: '127.0.0.1', port, origin: `http://127.0.0.1:${port}` });
    console.log(`Shipcast on http://127.0.0.1:${port} (no SHIPCAST_TLS_CLOUDFLARE_TOKEN: plain HTTP, this machine only; GitHub sign-in needs ${app.publicUrl})`);
    console.log(`Sign in: http://127.0.0.1:${port}${signInPath(consoleLinks().create())}`);
    return;
  }

  const certificate = await ensureCertificate({ domain, cloudflareToken: app.tlsCloudflareToken, secrets, dataDir: config.dataDir, log: console.log });
  const server = await serve({ host: app.host, port: app.port, origin: app.publicUrl, tls: certificate });
  if (process.env.SHIPCAST_APP_TAILSCALE !== 'off') {
    try {
      await run('tailscale', ['serve', '--bg', '--tcp', '443', `tcp://${app.host}:${app.port}`]);
    } catch (error) {
      console.error(`Tailscale Serve did not forward port 443 (${error instanceof Error ? error.message : String(error)}); run: tailscale serve --bg --tcp 443 tcp://${app.host}:${app.port}`);
    }
  }
  console.log(`Shipcast on ${app.publicUrl} (tailnet only)`);
  console.log(`Sign in without GitHub, once: ${app.publicUrl}${signInPath(consoleLinks().create())}`);

  // A certificate renewed in the background is picked up by the next start; check once a day
  setInterval(() => {
    ensureCertificate({ domain, cloudflareToken: app.tlsCloudflareToken!, secrets, dataDir: config.dataDir, log: console.log })
      .then((fresh) => server.setCertificate(fresh))
      .catch((error: unknown) => console.error(`certificate renewal failed: ${error instanceof Error ? error.message : String(error)}`));
  }, 24 * 3600 * 1000).unref();
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
