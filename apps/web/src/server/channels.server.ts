import { readFileSync } from 'node:fs';
import { exchangeMastodonCode, MASTODON_SCOPES, mastodonAuthorizeUrl, registerMastodonApp } from '@shipcast/connectors';
import { connectAccount, credentialsFor, getJson, isStale, lastSynced, network, NETWORK_SPECS, networkSpec, NETWORKS, type AccountDeps, type Credentials } from '@shipcast/runtime';
import { accountGrowth } from '@shipcast/engine';
import { processState } from '@shipcast/runtime/redis';
import { appContext, type AppContext } from './context.server';
import { accountAvatar } from './pieces.ts';

export async function accountDeps(): Promise<AccountDeps> {
  const { registry, secrets, brands } = await appContext();
  return { registry, secrets, brands: await brands() };
}

/** Everything the Channels page shows: the catalog, each network's accounts, and what still comes from .env */
export async function channelsView() {
  const ctx = await appContext();
  const { registry, secrets, brand } = ctx;
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
  for (const network of NETWORKS) {
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
    networks: NETWORKS.map((n) => ({
      ...n,
      accounts: accounts.filter((a) => a.network === n.id),
      usesEnv: fromEnv.includes(n.id),
    })),
  };
}

/**
 * OAuth sign-ins in flight, by state: which network, brand and instance they are for, ten minutes
 * each and good once. In the process's one-time store: memory, or Redis with `redis-state` on, so a
 * sign-in started on one replica finishes on whichever one the network's redirect reaches.
 */
type OAuthNetwork = string;
interface Flow {
  network: OAuthNetwork;
  brand: string;
  instance?: string;
  label?: string;
}
const OAUTH_NAMESPACE = 'oauth-state';

function remember(entry: Flow): Promise<string> {
  // JSON keeps no undefined: the fields not given are left out
  const value: Record<string, string> = { network: entry.network, brand: entry.brand };
  if (entry.instance !== undefined) value.instance = entry.instance;
  if (entry.label !== undefined) value.label = entry.label;
  return processState().shared.oneTime.put(OAUTH_NAMESPACE, value, 10 * 60);
}

/** The flow a callback belongs to, taken once: a state is never good twice, on any replica */
async function takeFlow(url: URL, network: OAuthNetwork): Promise<Flow | undefined> {
  const state = url.searchParams.get('state') ?? '';
  if (!state) return undefined;
  const flow = await processState().shared.oneTime.take<Record<string, string>>(OAUTH_NAMESPACE, state);
  if (!flow || flow.network !== network || flow.brand === undefined) return undefined;
  return { network, brand: flow.brand, ...(flow.instance !== undefined && { instance: flow.instance }), ...(flow.label !== undefined && { label: flow.label }) };
}

const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
/** A failed flow goes back to the network's page, which shows the problem */
const back = (network: string, problem: string) => redirect(`/channels/${network}?${new URLSearchParams({ problem })}`);

/** A connected account lands on the channels list, scrolled to it and focused */
const connected = (account: { id: number; identity: string | null; label: string }) =>
  redirect(`/channels?${new URLSearchParams({ connected: `Connected ${account.identity ?? account.label}`, focus: String(account.id) })}`);

/** Mastodon: register Shipcast on the instance once (its client is kept in the keychain), then authorise */
export async function startMastodon(request: Request): Promise<Response> {
  const { app, secrets } = await appContext();
  const url = new URL(request.url);
  const brand = url.searchParams.get('brand') ?? 'personal';
  let instance: string;
  try {
    instance = new URL(url.searchParams.get('instance') || 'https://mastodon.social').origin;
  } catch {
    return back('mastodon', 'That instance is not an address: write it as https://mastodon.social');
  }
  const redirectUri = `${app.publicUrl}/auth/mastodon/callback`;
  const key = `app:mastodon-client:${new URL(instance).host}`;
  let client = await getJson(secrets, key);
  // A client registered with fewer scopes cannot be asked for more: it is registered again
  if (!client?.clientId || client.redirectUri !== redirectUri || client.scopes !== MASTODON_SCOPES) {
    try {
      const registered = await registerMastodonApp(instance, redirectUri);
      client = { ...registered, redirectUri, scopes: MASTODON_SCOPES };
      await secrets.set(key, JSON.stringify(client), `Mastodon app on ${new URL(instance).host}`);
    } catch (error) {
      return back('mastodon', `${new URL(instance).host} refused to register Shipcast: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const state = await remember({ network: 'mastodon', brand, instance, label: url.searchParams.get('label') ?? undefined });
  return redirect(mastodonAuthorizeUrl(instance, client.clientId!, redirectUri, state));
}

export async function finishMastodon(request: Request): Promise<Response> {
  const { app, secrets } = await appContext();
  const url = new URL(request.url);
  const flow = await takeFlow(url, 'mastodon');
  if (!flow?.instance) return back('mastodon', 'This authorisation is stale or was not started here: try again.');
  const code = url.searchParams.get('code');
  if (!code) return back('mastodon', `Mastodon did not authorise Shipcast: ${url.searchParams.get('error_description') ?? 'cancelled'}.`);
  const client = await getJson(secrets, `app:mastodon-client:${new URL(flow.instance).host}`);
  if (!client?.clientId || !client.clientSecret) return back('mastodon', 'Shipcast’s registration on the instance was lost: try again.');
  try {
    const accessToken = await exchangeMastodonCode(flow.instance, { clientId: client.clientId, clientSecret: client.clientSecret }, `${app.publicUrl}/auth/mastodon/callback`, code);
    const result = await connectAccount(await accountDeps(), {
      network: 'mastodon',
      brand: flow.brand,
      label: flow.label,
      // The scopes granted are public and tell the app whether this token may edit the profile
      credentials: { settings: { instance: flow.instance, scopes: MASTODON_SCOPES }, secrets: { accessToken } },
    });
    return result.ok ? connected(result.account) : back('mastodon', result.problem);
  } catch (error) {
    return back('mastodon', error instanceof Error ? error.message : String(error));
  }
}

/**
 * A network's sign-in with the owner's app (its id and secret in Settings), for every network whose
 * spec has `oauth` (packages/runtime/src/channels): Instagram, Threads, LinkedIn, Reddit, and any
 * network added since. `/auth/<network>` starts it and `/auth/<network>/callback` finishes it.
 */
export async function startOAuth(networkId: string, request: Request): Promise<Response> {
  const ctx = await appContext();
  const spec = networkSpec(networkId)?.oauth;
  if (!spec) return back(networkId, `${networkId} has no sign-in.`);
  const app = ctx.settings.oauthApp(networkId);
  if (!app) return back(networkId, `Set the ${spec.app.name} ${spec.app.term} id and secret in Settings (/settings) first.`);
  const url = new URL(request.url);
  const state = await remember({ network: networkId, brand: url.searchParams.get('brand') ?? 'personal', label: url.searchParams.get('label') ?? undefined });
  return redirect(spec.authorizeUrl(app, `${ctx.app.publicUrl}/auth/${networkId}/callback`, state));
}

export async function finishOAuth(networkId: string, request: Request): Promise<Response> {
  const ctx = await appContext();
  const spec = networkSpec(networkId)?.oauth;
  const app = ctx.settings.oauthApp(networkId);
  const url = new URL(request.url);
  const flow = await takeFlow(url, networkId);
  if (!flow || !spec) return back(networkId, 'This authorisation is stale or was not started here: try again.');
  const code = url.searchParams.get('code');
  const name = network(networkId)?.name ?? networkId;
  if (!code || !app) return back(networkId, `${name} did not authorise Shipcast: ${spec.errorParams.map((p) => url.searchParams.get(p)).find(Boolean) ?? 'cancelled'}.`);
  try {
    const token = await spec.exchange(app, `${ctx.app.publicUrl}/auth/${networkId}/callback`, code);
    return await connectWith(networkId, flow, token);
  } catch (error) {
    return back(networkId, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Keeps the account a sign-in (or an import of the same credentials) produced, through the one path
 * every connection takes: checked first, its secrets in the keychain
 */
async function connectWith(networkId: string, flow: { brand: string; label?: string }, token: { label?: string; credentials: Credentials }): Promise<Response> {
  const result = await connectAccount(await accountDeps(), { network: networkId, brand: flow.brand, label: flow.label ?? token.label, credentials: token.credentials });
  return result.ok ? connected(result.account) : back(networkId, result.problem);
}
