import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  exchangeInstagramCode,
  exchangeMastodonCode,
  instagramAuthorizeUrl,
  mastodonAuthorizeUrl,
  registerMastodonApp,
} from '@shipcast/connectors';
import { connectAccount, credentialsFor, getJson, NETWORKS, type AccountDeps } from '@shipcast/runtime';
import { appContext } from './context.server';

export async function accountDeps(): Promise<AccountDeps> {
  const { registry, secrets, brands } = await appContext();
  return { registry, secrets, brands: await brands() };
}

/** Everything the Channels page shows: the catalog, each network's accounts, and what still comes from .env */
export async function channelsView() {
  const { registry, secrets, app, brand } = await appContext();
  const current = await brand();
  const accounts = await registry.accounts();
  const fromEnv: string[] = [];
  for (const network of NETWORKS) {
    if (network.auth === 'none' || accounts.some((a) => a.network === network.id && a.brand === current.id)) continue;
    const found = await credentialsFor(network.id, { env: process.env, brand: current, registry, secrets, readFile: (p) => readFileSync(p, 'utf8') }).catch(() => undefined);
    if (found?.origin.kind === 'env') fromEnv.push(network.id);
  }
  return {
    brands: [{ id: current.id, name: current.displayName }],
    secretsKind: secrets.kind,
    instagramOAuth: app.instagram !== undefined,
    networks: NETWORKS.map((n) => ({
      ...n,
      accounts: accounts.filter((a) => a.network === n.id),
      usesEnv: fromEnv.includes(n.id),
    })),
  };
}

/** OAuth sign-ins in flight, by state: which network, brand and instance they are for. Ten minutes each. */
const pending = new Map<string, { network: 'mastodon' | 'instagram'; brand: string; instance?: string; label?: string; expires: number }>();

function remember(entry: { network: 'mastodon' | 'instagram'; brand: string; instance?: string; label?: string }): string {
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
  if (!client?.clientId || client.redirectUri !== redirectUri) {
    try {
      const registered = await registerMastodonApp(instance, redirectUri);
      client = { ...registered, redirectUri };
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
      credentials: { settings: { instance: flow.instance }, secrets: { accessToken } },
    });
    return result.ok ? connected(result.account) : back('mastodon', result.problem);
  } catch (error) {
    return back('mastodon', error instanceof Error ? error.message : String(error));
  }
}

/** Instagram Login: needs the app id and secret of the owner's Meta app in .env */
export async function startInstagram(request: Request): Promise<Response> {
  const { app } = await appContext();
  if (!app.instagram) return back('instagram', 'Add INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET to .env, then restart the app.');
  const url = new URL(request.url);
  const state = remember({ network: 'instagram', brand: url.searchParams.get('brand') ?? 'personal', label: url.searchParams.get('label') ?? undefined });
  return redirect(instagramAuthorizeUrl(app.instagram.appId, `${app.publicUrl}/auth/instagram/callback`, state));
}

export async function finishInstagram(request: Request): Promise<Response> {
  const { app } = await appContext();
  const url = new URL(request.url);
  const flow = pending.get(url.searchParams.get('state') ?? '');
  pending.delete(url.searchParams.get('state') ?? '');
  if (!flow || flow.network !== 'instagram' || flow.expires < Date.now()) return back('instagram', 'This authorisation is stale or was not started here: try again.');
  const code = url.searchParams.get('code');
  if (!code || !app.instagram) return back('instagram', `Instagram did not authorise Shipcast: ${url.searchParams.get('error_description') ?? url.searchParams.get('error_reason') ?? 'cancelled'}.`);
  try {
    const token = await exchangeInstagramCode(app.instagram, `${app.publicUrl}/auth/instagram/callback`, code);
    const result = await connectAccount(await accountDeps(), {
      network: 'instagram',
      brand: flow.brand,
      label: flow.label,
      credentials: { settings: { userId: token.userId, refreshedAt: new Date().toISOString() }, secrets: { accessToken: token.accessToken } },
    });
    return result.ok ? connected(result.account) : back('instagram', result.problem);
  } catch (error) {
    return back('instagram', error instanceof Error ? error.message : String(error));
  }
}
