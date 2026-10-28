import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { exchangeMastodonCode, MASTODON_SCOPES, mastodonAuthorizeUrl, registerMastodonApp } from '@shipcast/connectors';
import { connectAccount, credentialsFor, getJson, isStale, lastSynced, network, NETWORK_SPECS, networkSpec, NETWORKS, type AccountDeps, type Credentials } from '@shipcast/runtime';
import { accountGrowth } from '@shipcast/engine';
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

/** OAuth sign-ins in flight, by state: which network, brand and instance they are for. Ten minutes each. */
type OAuthNetwork = string;
const pending = new Map<string, { network: OAuthNetwork; brand: string; instance?: string; label?: string; expires: number }>();

function remember(entry: { network: OAuthNetwork; brand: string; instance?: string; label?: string }): string {
  const state = randomBytes(18).toString('base64url');
  for (const [key, value] of pending) if (value.expires < Date.now()) pending.delete(key);
  pending.set(state, { ...entry, expires: Date.now() + 10 * 60_000 });
  return state;
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
  const state = remember({ network: 'mastodon', brand, instance, label: url.searchParams.get('label') ?? undefined });
  return redirect(mastodonAuthorizeUrl(instance, client.clientId!, redirectUri, state));
}

export async function finishMastodon(request: Request): Promise<Response> {
  const { app, secrets } = await appContext();
  const url = new URL(request.url);
  const flow = pending.get(url.searchParams.get('state') ?? '');
  pending.delete(url.searchParams.get('state') ?? '');
  if (!flow || flow.network !== 'mastodon' || !flow.instance || flow.expires < Date.now()) return back('mastodon', 'This authorisation is stale or was not started here: try again.');
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

/** The flow a callback belongs to, taken once: a state is never good twice */
function takeFlow(url: URL, network: OAuthNetwork) {
  const state = url.searchParams.get('state') ?? '';
  const flow = pending.get(state);
  pending.delete(state);
  return flow && flow.network === network && flow.expires >= Date.now() ? flow : undefined;
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
  const state = remember({ network: networkId, brand: url.searchParams.get('brand') ?? 'personal', label: url.searchParams.get('label') ?? undefined });
  return redirect(spec.authorizeUrl(app, `${ctx.app.publicUrl}/auth/${networkId}/callback`, state));
}

export async function finishOAuth(networkId: string, request: Request): Promise<Response> {
  const ctx = await appContext();
  const spec = networkSpec(networkId)?.oauth;
  const app = ctx.settings.oauthApp(networkId);
  const url = new URL(request.url);
  const flow = takeFlow(url, networkId);
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
