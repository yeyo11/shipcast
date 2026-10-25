import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { KeychainStore, loadAppConfig, loadConfig } from '@shipcast/runtime';
import { ensureCertificate, type DnsSolver } from '../tls.ts';

/**
 * Gets the app's certificate when there is no Cloudflare token: the challenge's TXT record is written
 * to `data/tls/challenge.json` for someone (a person, or an agent with DNS access) to create by hand,
 * and the script waits until public DNS answers it. Renewal still needs the token.
 */

const ROOT = resolve(import.meta.dirname, '../../..');
const config = loadConfig(process.env, ROOT);
const app = loadAppConfig(process.env);
const file = join(config.dataDir, 'tls', 'challenges.json');
const aliases = (process.env.SHIPCAST_APP_ALIASES ?? '').split(',').map((a) => a.trim()).filter(Boolean);

/** Several names are challenged at once, so the file lists every record still to be placed */
function pending(change: (list: Array<{ name: string; value: string }>) => Array<{ name: string; value: string }>): void {
  const list = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Array<{ name: string; value: string }>) : [];
  writeFileSync(file, JSON.stringify(change(list), null, 2));
}

async function answered(name: string, value: string): Promise<boolean> {
  const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${name}&type=TXT`, { headers: { accept: 'application/dns-json' } }).catch(() => undefined);
  const body = (await response?.json().catch(() => undefined)) as { Answer?: Array<{ data: string }> } | undefined;
  return body?.Answer?.some((a) => a.data.replace(/"/g, '') === value) ?? false;
}

const byHand: DnsSolver = {
  async create(name, value) {
    mkdirSync(join(config.dataDir, 'tls'), { recursive: true });
    pending((list) => [...list, { name, value }]);
    console.log(`Create the TXT record ${name} = ${value} (written to ${file}); waiting for DNS…`);
    while (!(await answered(name, value))) await new Promise((r) => setTimeout(r, 5000));
    console.log('DNS answers the record.');
  },
  async remove(name, value) {
    pending((list) => list.filter((r) => r.value !== value));
    console.log(`The TXT record ${name} can be deleted now.`);
  },
};

const certificate = await ensureCertificate(
  { domain: new URL(app.publicUrl).hostname, altNames: aliases.map((a) => new URL(a).hostname), dns: byHand, secrets: new KeychainStore(), dataDir: config.dataDir, log: console.log, staging: process.argv.includes('--staging') },
  process.argv.includes('--force') ? new Date(Date.now() + 365 * 86_400_000) : new Date(),
);
console.log(`Certificate valid until ${certificate.expires.toISOString()}`);
