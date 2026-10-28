import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  exchangeInstagramCode,
  exchangeLinkedInCode,
  exchangeMastodonCode,
  exchangeRedditCode,
  exchangeThreadsCode,
  instagramAuthorizeUrl,
  linkedinAuthorizeUrl,
  MASTODON_SCOPES,
  mastodonAuthorizeUrl,
  redditAuthorizeUrl,
  registerMastodonApp,
  threadsAuthorizeUrl,
} from '@shipcast/connectors';
import { connectAccount, credentialsFor, getJson, isStale, lastSynced, NETWORKS, type AccountDeps } from '@shipcast/runtime';
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
    instagramOAuth: instagramApp(ctx) !== undefined,
    /** Which OAuth networks have the owner's app set in Settings; Mastodon registers itself */
    oauthReady: { instagram: instagramApp(ctx) !== undefined, threads: threadsApp(ctx) !== undefined, linkedin: linkedinApp(ctx) !== undefined, reddit: redditApp(ctx) !== undefined } as Record<string, boolean>,
    networks: NETWORKS.map((n) => ({
      ...n,
      accounts: accounts.filter((a) => a.network === n.id),
      usesEnv: fromEnv.includes(n.id),
    })),
  };
}

/** OAuth sign-ins in flight, by state: which network, brand and instance they are for. Ten minutes each. */
type OAuthNetwork = 'mastodon' | 'instagram' | 'threads' | 'linkedin' | 'reddit';
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

/** The owner's Meta app for Instagram Login, from the settings; undefined until both are set */
function instagramApp(ctx: Pick<AppContext, 'settings'>) {
  const { instagramAppId, instagramAppSecret } = ctx.settings.current();
  return instagramAppId && instagramAppSecret ? { appId: instagramAppId, appSecret: instagramAppSecret } : undefined;
}

/** Instagram Login: needs the app id and secret of the owner's Meta app, set in Settings */
export async function startInstagram(request: Request): Promise<Response> {
  const ctx = await appContext();
  const { app } = ctx;
  const instagram = instagramApp(ctx);
  if (!instagram) return back('instagram', 'Set the Instagram app id and secret in Settings (/settings) first.');
  const url = new URL(request.url);
  const state = remember({ network: 'instagram', brand: url.searchParams.get('brand') ?? 'personal', label: url.searchParams.get('label') ?? undefined });
  return redirect(instagramAuthorizeUrl(instagram.appId, `${app.publicUrl}/auth/instagram/callback`, state));
}

export async function finishInstagram(request: Request): Promise<Response> {
  const ctx = await appContext();
  const { app } = ctx;
  const instagram = instagramApp(ctx);
  const url = new URL(request.url);
  const flow = pending.get(url.searchParams.get('state') ?? '');
  pending.delete(url.searchParams.get('state') ?? '');
  if (!flow || flow.network !== 'instagram' || flow.expires < Date.now()) return back('instagram', 'This authorisation is stale or was not started here: try again.');
  const code = url.searchParams.get('code');
  if (!code || !instagram) return back('instagram', `Instagram did not authorise Shipcast: ${url.searchParams.get('error_description') ?? url.searchParams.get('error_reason') ?? 'cancelled'}.`);
  try {
    const token = await exchangeInstagramCode(instagram, `${app.publicUrl}/auth/instagram/callback`, code);
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

/** The Threads use case of the owner's Meta app, from the settings; undefined until both are set */
function threadsApp(ctx: Pick<AppContext, 'settings'>) {
  const { threadsAppId, threadsAppSecret } = ctx.settings.current();
  return threadsAppId && threadsAppSecret ? { appId: threadsAppId, appSecret: threadsAppSecret } : undefined;
}

/** The owner's LinkedIn app, from the settings; undefined until both are set */
function linkedinApp(ctx: Pick<AppContext, 'settings'>) {
  const { linkedinClientId, linkedinClientSecret } = ctx.settings.current();
  return linkedinClientId && linkedinClientSecret ? { clientId: linkedinClientId, clientSecret: linkedinClientSecret } : undefined;
}

/** The owner's Reddit app, from the settings; undefined until both are set */
function redditApp(ctx: Pick<AppContext, 'settings'>) {
  const { redditClientId, redditClientSecret } = ctx.settings.current();
  return redditClientId && redditClientSecret ? { clientId: redditClientId, clientSecret: redditClientSecret } : undefined;
}

/** The flow a callback belongs to, taken once: a state is never good twice */
function takeFlow(url: URL, network: OAuthNetwork) {
  const state = url.searchParams.get('state') ?? '';
  const flow = pending.get(state);
  pending.delete(state);
  return flow && flow.network === network && flow.expires >= Date.now() ? flow : undefined;
}

/** Threads: needs the app id and secret of the owner's Meta app (its Threads use case), set in Settings */
export async function startThreads(request: Request): Promise<Response> {
  const ctx = await appContext();
  const threads = threadsApp(ctx);
  if (!threads) return back('threads', 'Set the Threads app id and secret in Settings (/settings) first.');
  const url = new URL(request.url);
  const state = remember({ network: 'threads', brand: url.searchParams.get('brand') ?? 'personal', label: url.searchParams.get('label') ?? undefined });
  return redirect(threadsAuthorizeUrl(threads.appId, `${ctx.app.publicUrl}/auth/threads/callback`, state));
}

export async function finishThreads(request: Request): Promise<Response> {
  const ctx = await appContext();
  const threads = threadsApp(ctx);
  const url = new URL(request.url);
  const flow = takeFlow(url, 'threads');
  if (!flow) return back('threads', 'This authorisation is stale or was not started here: try again.');
  const code = url.searchParams.get('code');
  if (!code || !threads) return back('threads', `Threads did not authorise Shipcast: ${url.searchParams.get('error_description') ?? url.searchParams.get('error_reason') ?? 'cancelled'}.`);
  try {
    const token = await exchangeThreadsCode(threads, `${ctx.app.publicUrl}/auth/threads/callback`, code);
    const result = await connectAccount(await accountDeps(), {
      network: 'threads',
      brand: flow.brand,
      label: flow.label,
      credentials: { settings: { userId: token.userId, refreshedAt: new Date().toISOString() }, secrets: { accessToken: token.accessToken } },
    });
    return result.ok ? connected(result.account) : back('threads', result.problem);
  } catch (error) {
    return back('threads', error instanceof Error ? error.message : String(error));
  }
}

/** LinkedIn: needs the client id and secret of the owner's LinkedIn app, set in Settings */
export async function startLinkedIn(request: Request): Promise<Response> {
  const ctx = await appContext();
  const linkedin = linkedinApp(ctx);
  if (!linkedin) return back('linkedin', 'Set the LinkedIn client id and secret in Settings (/settings) first.');
  const url = new URL(request.url);
  const state = remember({ network: 'linkedin', brand: url.searchParams.get('brand') ?? 'personal', label: url.searchParams.get('label') ?? undefined });
  return redirect(linkedinAuthorizeUrl(linkedin.clientId, `${ctx.app.publicUrl}/auth/linkedin/callback`, state));
}

export async function finishLinkedIn(request: Request): Promise<Response> {
  const ctx = await appContext();
  const linkedin = linkedinApp(ctx);
  const url = new URL(request.url);
  const flow = takeFlow(url, 'linkedin');
  if (!flow) return back('linkedin', 'This authorisation is stale or was not started here: try again.');
  const code = url.searchParams.get('code');
  if (!code || !linkedin) return back('linkedin', `LinkedIn did not authorise Shipcast: ${url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? 'cancelled'}.`);
  try {
    const token = await exchangeLinkedInCode(linkedin, `${ctx.app.publicUrl}/auth/linkedin/callback`, code);
    const result = await connectAccount(await accountDeps(), {
      network: 'linkedin',
      brand: flow.brand,
      label: flow.label ?? token.name,
      // No refresh token for most apps: the expiry is kept so the account says when to connect again
      credentials: { settings: { personId: token.personId, expiresAt: new Date(Date.now() + token.expiresIn * 1000).toISOString() }, secrets: { accessToken: token.accessToken } },
    });
    return result.ok ? connected(result.account) : back('linkedin', result.problem);
  } catch (error) {
    return back('linkedin', error instanceof Error ? error.message : String(error));
  }
}

/** Reddit: needs the client id and secret of the owner's Reddit app, set in Settings */
export async function startReddit(request: Request): Promise<Response> {
  const ctx = await appContext();
  const reddit = redditApp(ctx);
  if (!reddit) return back('reddit', 'Set the Reddit client id and secret in Settings (/settings) first.');
  const url = new URL(request.url);
  const state = remember({ network: 'reddit', brand: url.searchParams.get('brand') ?? 'personal', label: url.searchParams.get('label') ?? undefined });
  return redirect(redditAuthorizeUrl(reddit.clientId, `${ctx.app.publicUrl}/auth/reddit/callback`, state));
}

export async function finishReddit(request: Request): Promise<Response> {
  const ctx = await appContext();
  const reddit = redditApp(ctx);
  const url = new URL(request.url);
  const flow = takeFlow(url, 'reddit');
  if (!flow) return back('reddit', 'This authorisation is stale or was not started here: try again.');
  const code = url.searchParams.get('code');
  if (!code || !reddit) return back('reddit', `Reddit did not authorise Shipcast: ${url.searchParams.get('error') ?? 'cancelled'}.`);
  try {
    const token = await exchangeRedditCode(reddit, `${ctx.app.publicUrl}/auth/reddit/callback`, code);
    const result = await connectAccount(await accountDeps(), {
      network: 'reddit',
      brand: flow.brand,
      label: flow.label ?? `u/${token.username}`,
      // The app's client goes with the account: its refresh token is only good with that app
      credentials: { settings: { username: token.username, clientId: reddit.clientId }, secrets: { refreshToken: token.refreshToken, clientSecret: reddit.clientSecret } },
    });
    return result.ok ? connected(result.account) : back('reddit', result.problem);
  } catch (error) {
    return back('reddit', error instanceof Error ? error.message : String(error));
  }
}
