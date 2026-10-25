import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { ConfigError, KeychainStore, loadAppConfig, loadConfig } from '@shipcast/runtime';
import { serve } from './server.ts';
import { consoleLinks, signInPath } from './src/server/console-links.ts';
import { cloudflareDns, current, ensureCertificate } from './tls.ts';

/**
 * `pnpm app`: the built app on the owner's domain. It serves HTTPS on 127.0.0.1 with the domain's
 * certificate and asks Tailscale Serve to forward the tailnet's port 443 to it, so the domain (whose
 * DNS record points at this machine's tailnet address) reaches it from the owner's devices only.
 * With a Cloudflare token the certificate is obtained and renewed here; without one, a certificate
 * already on disk is used until it expires; with neither, plain HTTP on localhost.
 */

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '../..');
const DAY = 24 * 3600 * 1000;

async function main(): Promise<void> {
  const config = loadConfig(process.env, ROOT);
  const app = loadAppConfig(process.env);
  const secrets = new KeychainStore();
  const domain = new URL(app.publicUrl).hostname;
  const token = app.tlsCloudflareToken;
  // The app's address on the local network, if it has one: another https origin on the same certificate
  const aliases = (process.env.SHIPCAST_APP_ALIASES ?? '').split(',').map((a) => a.trim().replace(/\/+$/, '')).filter(Boolean);
  const options = { domain, altNames: aliases.map((a) => new URL(a).hostname), secrets, dataDir: config.dataDir, log: console.log };

  const certificate = token ? await ensureCertificate({ ...options, dns: cloudflareDns(token, domain) }) : await current(options);
  if (!certificate || certificate.expires.getTime() < Date.now()) {
    const port = app.port;
    await serve({ host: '127.0.0.1', port, origin: `http://127.0.0.1:${port}` });
    console.log(`Shipcast on http://127.0.0.1:${port} (no certificate and no SHIPCAST_TLS_CLOUDFLARE_TOKEN: plain HTTP, this machine only; GitHub sign-in needs ${app.publicUrl})`);
    console.log(`Sign in: http://127.0.0.1:${port}${signInPath(consoleLinks().create())}`);
    return;
  }

  const server = await serve({ host: app.host, port: app.port, origin: app.publicUrl, aliases, tls: certificate });
  if (process.env.SHIPCAST_APP_TAILSCALE !== 'off') {
    try {
      await run('tailscale', ['serve', '--bg', '--tcp', '443', `tcp://${app.host}:${app.port}`]);
    } catch (error) {
      console.error(`Tailscale Serve did not forward port 443 (${error instanceof Error ? error.message : String(error)}); run: tailscale serve --bg --tcp 443 tcp://${app.host}:${app.port}`);
    }
  }
  console.log(`Shipcast on ${[app.publicUrl, ...aliases].join(' and ')}; certificate valid until ${certificate.expires.toISOString().slice(0, 10)}`);
  console.log(`Sign in without GitHub, once: ${app.publicUrl}${signInPath(consoleLinks().create())}`);

  if (!token) {
    const days = Math.floor((certificate.expires.getTime() - Date.now()) / DAY);
    console.log(`No SHIPCAST_TLS_CLOUDFLARE_TOKEN: the certificate is not renewed here (${days} days left).`);
    return;
  }
  // A certificate renewed in the background is swapped in without a restart; checked once a day
  setInterval(() => {
    ensureCertificate({ ...options, dns: cloudflareDns(token, domain) })
      .then((fresh) => server.setCertificate(fresh))
      .catch((error: unknown) => console.error(`certificate renewal failed: ${error instanceof Error ? error.message : String(error)}`));
  }, DAY).unref();
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
