/*
 * The VAPID key pair web push is signed with (RFC 8292), from the environment like the app's other
 * server secrets (docs/push.md). Absent, push is "not configured": Settings says so and nothing is
 * sent; nothing else changes, and a half-set pair never stops a start either, it is only reported.
 *
 *   pnpm --filter @shipcast/runtime exec web-push generate-vapid-keys
 *
 * prints a new pair. The public key reaches every subscribed browser, so changing it means each device
 * turns notifications on again.
 */

export const VAPID_VARIABLES = ['SHIPCAST_VAPID_PUBLIC_KEY', 'SHIPCAST_VAPID_PRIVATE_KEY'] as const;

export interface PushConfig {
  /** The public key, base64url: what a browser subscribes with (applicationServerKey) */
  publicKey: string;
  privateKey: string;
  /** Who the push services may contact about this sender: a mailto: or https: address */
  subject: string;
}

export type PushSetup = { state: 'ready'; config: PushConfig } | { state: 'off' } | { state: 'invalid'; problem: string };

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const bytesOf = (value: string) => (BASE64URL.test(value) ? Buffer.from(value, 'base64url') : undefined);

/**
 * Reads the key pair and its subject: SHIPCAST_VAPID_SUBJECT, or else the app's own address
 * (SHIPCAST_PUBLIC_URL), which the push services accept as an https: contact.
 */
export function pushSetup(env: NodeJS.ProcessEnv = process.env): PushSetup {
  const value = (name: string) => env[name]?.trim() || undefined;
  const given = VAPID_VARIABLES.filter((n) => value(n));
  if (given.length === 0) return { state: 'off' };
  const missing = VAPID_VARIABLES.filter((n) => !value(n));
  if (missing.length > 0) return { state: 'invalid', problem: `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} missing` };
  const publicKey = value('SHIPCAST_VAPID_PUBLIC_KEY')!;
  const privateKey = value('SHIPCAST_VAPID_PRIVATE_KEY')!;
  // An uncompressed P-256 point and its private scalar; never echoed, a key pasted wrong would land in the logs
  const pub = bytesOf(publicKey);
  if (!pub || pub.length !== 65 || pub[0] !== 4) return { state: 'invalid', problem: 'SHIPCAST_VAPID_PUBLIC_KEY is not a VAPID public key (65 bytes, base64url)' };
  const key = bytesOf(privateKey);
  if (!key || key.length !== 32) return { state: 'invalid', problem: 'SHIPCAST_VAPID_PRIVATE_KEY is not a VAPID private key (32 bytes, base64url)' };
  const subject = value('SHIPCAST_VAPID_SUBJECT') ?? value('SHIPCAST_PUBLIC_URL');
  if (!subject || !/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(subject)) return { state: 'invalid', problem: 'SHIPCAST_VAPID_SUBJECT must be a mailto: or https: address (SHIPCAST_PUBLIC_URL is used when it is unset)' };
  return { state: 'ready', config: { publicKey, privateKey, subject } };
}
