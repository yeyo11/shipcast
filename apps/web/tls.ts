import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SecretStore } from '@shipcast/runtime';
import acme from 'acme-client';

/**
 * The app's certificate, from Let's Encrypt through the DNS challenge on Cloudflare: the app lives
 * on a private tailnet address that no certificate authority can reach, so the proof of control is
 * a TXT record, not an HTTP request. Tailscale Serve only issues `*.ts.net` certificates, which is
 * why Shipcast obtains its own for the owner's domain.
 */

const RENEW_BEFORE_MS = 30 * 24 * 3600 * 1000;

export interface CertificateOptions {
  domain: string;
  cloudflareToken: string;
  secrets: SecretStore;
  /** Where the certificate (public) is kept; the private keys go to the keychain */
  dataDir: string;
  log?: (line: string) => void;
  /** Let's Encrypt's staging directory, for trying the flow without spending the real rate limit */
  staging?: boolean;
}

async function cloudflare<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const answer = (await response.json()) as { success: boolean; result: T; errors: Array<{ message: string }> };
  if (!answer.success) throw new Error(`Cloudflare ${method} ${path}: ${answer.errors.map((e) => e.message).join('; ') || response.status}`);
  return answer.result;
}

/** The zone that holds a name: the longest of its suffixes Cloudflare knows */
async function zoneOf(token: string, domain: string): Promise<string> {
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const zones = await cloudflare<Array<{ id: string }>>(token, 'GET', `/zones?name=${labels.slice(i).join('.')}`);
    if (zones[0]) return zones[0].id;
  }
  throw new Error(`no Cloudflare zone holds ${domain}: the token needs Zone DNS edit on it`);
}

/** When the certificate on disk expires, if there is one and its key is in the keychain */
async function current(options: CertificateOptions): Promise<{ key: string; cert: string; expires: Date } | undefined> {
  const path = join(options.dataDir, 'tls', `${options.domain}.crt`);
  if (!existsSync(path)) return undefined;
  const key = await options.secrets.get(`app:tls-key:${options.domain}`);
  if (!key) return undefined;
  const cert = readFileSync(path, 'utf8');
  return { key, cert, expires: acme.crypto.readCertificateInfo(cert).notAfter };
}

/**
 * A valid certificate for the domain: the one on disk while it has more than 30 days left,
 * otherwise a new one. Let's Encrypt's certificates last 90 days, so this renews every 60 or so.
 */
export async function ensureCertificate(options: CertificateOptions, now = new Date()): Promise<{ key: string; cert: string; expires: Date }> {
  const log = options.log ?? (() => {});
  const found = await current(options);
  if (found && found.expires.getTime() - now.getTime() > RENEW_BEFORE_MS) return found;

  log(`Getting a certificate for ${options.domain} from Let's Encrypt (DNS challenge on Cloudflare)…`);
  let accountKey = await options.secrets.get('app:acme-account-key');
  if (!accountKey) {
    accountKey = (await acme.crypto.createPrivateEcdsaKey()).toString();
    await options.secrets.set('app:acme-account-key', accountKey, "Let's Encrypt account key");
  }
  const client = new acme.Client({
    directoryUrl: options.staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production,
    accountKey,
  });
  const [key, csr] = await acme.crypto.createCsr({ commonName: options.domain }, await acme.crypto.createPrivateEcdsaKey());
  const zone = await zoneOf(options.cloudflareToken, options.domain);
  const records = new Map<string, string>();
  const cert = await client.auto({
    csr,
    termsOfServiceAgreed: true,
    challengePriority: ['dns-01'],
    // The local resolver may have cached the record's absence; Cloudflare serves it within seconds
    skipChallengeVerification: true,
    challengeCreateFn: async (authz, _challenge, keyAuthorization) => {
      const record = await cloudflare<{ id: string }>(options.cloudflareToken, 'POST', `/zones/${zone}/dns_records`, {
        type: 'TXT',
        name: `_acme-challenge.${authz.identifier.value}`,
        content: keyAuthorization,
        ttl: 60,
        comment: 'Shipcast certificate challenge, removed after',
      });
      records.set(keyAuthorization, record.id);
      await new Promise((r) => setTimeout(r, 15_000));
    },
    challengeRemoveFn: async (_authz, _challenge, keyAuthorization) => {
      const id = records.get(keyAuthorization);
      if (id) await cloudflare(options.cloudflareToken, 'DELETE', `/zones/${zone}/dns_records/${id}`).catch(() => undefined);
    },
  });

  mkdirSync(join(options.dataDir, 'tls'), { recursive: true });
  writeFileSync(join(options.dataDir, 'tls', `${options.domain}.crt`), cert);
  await options.secrets.set(`app:tls-key:${options.domain}`, key.toString(), `TLS key for ${options.domain}`);
  const expires = acme.crypto.readCertificateInfo(cert).notAfter;
  log(`Certificate for ${options.domain} valid until ${expires.toISOString().slice(0, 10)}`);
  return { key: key.toString(), cert, expires };
}
