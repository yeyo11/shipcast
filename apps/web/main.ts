import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { ConfigError, loadAppConfig, loadConfig, secretStoreFor } from '@shipcast/runtime';
import { serve } from './server.ts';
import { consoleLinks, signInPath } from './src/server/console-links.ts';
import { cloudflareDns, current, ensureCertificate } from './tls.ts';

/**
 * `pnpm app`: the built app on the owner's domain. It serves HTTPS on 127.0.0.1 with the domain's
 * certificate and asks Tailscale Serve to forward the tailnet's port 443 to it, so the domain (whose
 * DNS record points at this machine's tailnet address) reaches it from the owner's devices only.
 * With a Cloudflare token the certificate is obtained and renewed here; without one, a certificate
 * already on disk is used until it expires; with neither, plain HTTP on localhost. On a server behind
 * a proxy (SHIPCAST_APP_TLS=proxy) the proxy does TLS and the app serves plain HTTP.
 */

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '../..');
const DAY = 24 * 3600 * 1000;

async function main(): Promise<void> {
  const config = loadConfig(process.env, ROOT);
  const app = loadAppConfig(process.env);
  const proxied = process.env.SHIPCAST_APP_TLS === 'proxy';
  // The registry's table opens with the registry, inside the app's context: certificates are the proxy's job there
  const inTable = process.env.SHIPCAST_SECRET_STORE?.trim() === 'table';
  if (inTable && !proxied) throw new ConfigError('SHIPCAST_SECRET_STORE=table runs behind a proxy that does TLS: set SHIPCAST_APP_TLS=proxy');
  // The bootstrap's keychain service: the TLS key lives there, so a second install or a test copy never touches another's
  const secrets = inTable ? undefined : secretStoreFor(config);
  const secretsKind = secrets?.kind ?? 'the registry’s encrypted secrets table';
  const domain = new URL(app.publicUrl).hostname;
  // A preview copy (SHIPCAST_APP_TLS=off) never reads, issues or writes certificate material
  const tls = process.env.SHIPCAST_APP_TLS !== 'off';
  const token = tls ? app.tlsCloudflareToken : undefined;


  /*
   * Behind a reverse proxy that terminates TLS (Traefik on a server, SHIPCAST_APP_TLS=proxy): plain
   * HTTP inside, on SHIPCAST_APP_HOST (every interface in a container, reachable by the proxy only),
   * and the public https origin outside, so the URLs the app builds point where the browser is and
   * its cookies keep the Secure flag. No certificate code and no Tailscale Serve.
   */
  if (proxied) {
    await serve({ host: app.host, port: app.port, origin: app.publicUrl });
    console.log(`Shipcast on ${app.publicUrl}, behind a proxy (plain HTTP on ${app.host}:${app.port}); secrets in ${secretsKind}`);
    console.log(`Sign in without GitHub, once: ${app.publicUrl}${signInPath(consoleLinks().create())}`);
    return;
  }

  // Not proxied, so never the table: the store is the keychain or the file
  const options = { domain, secrets: secrets!, dataDir: config.dataDir, log: console.log };
  const certificate = !tls ? undefined : token ? await ensureCertificate({ ...options, dns: cloudflareDns(token, domain) }) : await current(options);
  if (!certificate || certificate.expires.getTime() < Date.now()) {
    const port = app.port;
    /*
     * A preview copy (TLS off) listens on SHIPCAST_APP_HOST, so the owner can open it over the tailnet
     * from a phone; one address only, never every interface. Without a certificate by accident, plain
     * HTTP stays on this machine.
     */
    if (!tls && (app.host === '0.0.0.0' || app.host === '::')) throw new ConfigError('SHIPCAST_APP_TLS=off serves plain HTTP: set SHIPCAST_APP_HOST to one address (the tailnet one), not every interface');
    const host = tls ? '127.0.0.1' : app.host;
    const origin = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
    await serve({ host, port, origin, plainHttp: !tls });
    const why = tls ? 'no certificate and no SHIPCAST_TLS_CLOUDFLARE_TOKEN' : 'SHIPCAST_APP_TLS=off';
    console.log(`Shipcast on ${origin} (${why}: plain HTTP${tls ? ', this machine only' : ''}; GitHub sign-in needs ${app.publicUrl})`);
    console.log(`Sign in without GitHub, once: ${origin}${signInPath(consoleLinks().create())}`);
    return;
  }

  const server = await serve({ host: app.host, port: app.port, origin: app.publicUrl, tls: certificate });
  if (process.env.SHIPCAST_APP_TAILSCALE !== 'off') {
    try {
      await run('tailscale', ['serve', '--bg', '--tcp', '443', `tcp://${app.host}:${app.port}`]);
    } catch (error) {
      console.error(`Tailscale Serve did not forward port 443 (${error instanceof Error ? error.message : String(error)}); run: tailscale serve --bg --tcp 443 tcp://${app.host}:${app.port}`);
    }
  }
  console.log(`Shipcast on ${app.publicUrl} (tailnet only); certificate valid until ${certificate.expires.toISOString().slice(0, 10)}`);
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
