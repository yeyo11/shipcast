import { readFileSync } from 'node:fs';
import { accountGrowth, type Repositories } from '@shipcast/engine';
import { credentialsFor, isStale, lastSynced, NETWORK_SPECS, networksOn, type Flags, type RuntimeSettings, type SecretStore } from '@shipcast/runtime';
import type { Brand } from '@shipcast/schema';
import { accountAvatar } from './pieces.ts';

/** The page's view from what it reads: the registry, the keychain and the cached brand, never a network */
export async function channelsViewOf(ctx: { registry: Repositories; secrets: SecretStore; brand(): Promise<Brand>; settings: Pick<RuntimeSettings, 'oauthApp'>; flags: Flags }) {
  const { registry, secrets, brand } = ctx;
  // A network behind a flag (Umami) is not offered while its flag is off
  const networks = networksOn(ctx.flags);
  const current = await brand();
  const snapshots = await registry.accounts.lastSnapshots();
  const activity = await registry.posts.postActivity();
  const now = new Date();
  const week = { from: new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) };
  // Each account with its latest numbers, its week's change, what Shipcast published with it and how fresh it is
  const accounts = await Promise.all(
    (await registry.accounts.accounts()).map(async (account) => {
      const snapshot = snapshots.get(account.id) ?? null;
      const syncedAt = lastSynced(account, snapshot?.takenAt);
      const weekChange = snapshot?.followers != null ? (await accountGrowth(registry, account.id, week)).change.followers : null;
      return { ...account, avatarUrl: accountAvatar(account), snapshot, weekChange, activity: activity.get(account.id) ?? { count: 0, last: null }, syncedAt, stale: isStale(syncedAt, now) };
    }),
  );
  const fromEnv: string[] = [];
  for (const network of networks) {
    if (accounts.some((a) => a.network === network.id && a.brand === current.id)) continue;
    const found = await credentialsFor(network.id, { env: process.env, brand: current, registry, secrets, readFile: (p) => readFileSync(p, 'utf8') }).catch(() => undefined);
    if (found?.origin.kind === 'env') fromEnv.push(network.id);
  }
  return {
    brands: [{ id: current.id, name: current.displayName }],
    secretsKind: secrets.kind,
    instagramOAuth: ctx.settings.oauthApp('instagram') !== undefined,
    /** Which OAuth networks have the owner's app set in Settings, from their specs; Mastodon registers itself */
    oauthReady: Object.fromEntries(NETWORK_SPECS.filter((n) => n.oauth).map((n) => [n.id, ctx.settings.oauthApp(n.id) !== undefined])) as Record<string, boolean>,
    networks: networks.map((n) => ({
      ...n,
      accounts: accounts.filter((a) => a.network === n.id),
      usesEnv: fromEnv.includes(n.id),
    })),
  };
}

