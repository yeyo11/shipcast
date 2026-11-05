import { exchangeMastodonCode, MASTODON_SCOPES, mastodonAuthorizeUrl, registerMastodonApp } from '@shipcast/connectors';
import { connectAccount, getJson, network, networkSpec, type AccountDeps, type ConnectedAccount } from '@shipcast/runtime';
import { appContext, type AppContext } from './context.server';
import { channelsViewOf } from './channels-view.server.ts';
import { back, connectAll as connectAllWith, connected, flowSpec, oauthFlows, redirect, startFlow, type Flow } from './oauth-flows.ts';

export async function accountDeps(): Promise<AccountDeps> {
  return accountDepsOf(await appContext());
}

/** Over a context already in hand, as the account routes get theirs (accounts.server.ts) */
export async function accountDepsOf({ registry, secrets, brands, preview }: Pick<AppContext, 'registry' | 'secrets' | 'brands' | 'preview'>): Promise<AccountDeps> {
  // A preview checks a credential itself and reads through its own fetch: connecting reaches no network
  return { registry, secrets, brands: await brands(), ...(preview && { fetch: preview.fetch, check: preview.oauth.check }) };
}

/** Everything the Channels page shows: the catalog, each network's accounts, and what still comes from .env */
export async function channelsView() {
  return channelsViewOf(await appContext());
}

const remember = (flow: Flow) => oauthFlows().remember(flow);
const takeFlow = (url: URL, network: string) => oauthFlows().take(url, network);

/** Mastodon: register Shipcast on the instance once (its client is kept in the keychain), then authorise */
export async function startMastodon(request: Request): Promise<Response> {
  const { app, secrets, preview } = await appContext();
  const url = new URL(request.url);
  const brand = url.searchParams.get('brand') ?? 'personal';
  let instance: string;
  try {
    instance = new URL(url.searchParams.get('instance') || 'https://mastodon.social').origin;
  } catch {
    return back('mastodon', 'That instance is not an address: write it as https://mastodon.social');
  }
  // A preview registers nothing on the instance: its own consent sends the browser straight back
  if (preview) {
    const state = await remember({ network: 'mastodon', brand, instance, label: url.searchParams.get('label') ?? undefined });
    return redirect(preview.oauth.authorizeUrl(app.publicUrl, 'mastodon', state));
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
  const { app, secrets, preview } = await appContext();
  const url = new URL(request.url);
  const flow = await takeFlow(url, 'mastodon');
  if (!flow?.instance) return back('mastodon', 'This authorisation is stale or was not started here: try again.');
  const code = url.searchParams.get('code');
  if (!code) return back('mastodon', `Mastodon did not authorise Shipcast: ${url.searchParams.get('error_description') ?? 'cancelled'}.`);
  if (preview) return finishPreview('mastodon', flow, code, { instance: flow.instance, scopes: MASTODON_SCOPES });
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
  const found = networkSpec(networkId);
  const signIn = found && startFlow(found, ctx.settings.current(), new URL(request.url).searchParams);
  if (!signIn) return back(networkId, `${networkId} has no sign-in.`);
  const { spec, flow } = signIn;
  const app = ctx.settings.oauthApp(spec);
  // A preview's consent is its own, with no app of the owner's: the browser comes straight back to the callback, which may be another replica's
  if (ctx.preview) return redirect(ctx.preview.oauth.authorizeUrl(ctx.app.publicUrl, networkId, await remember(flow)));
  if (!app) return back(networkId, `Set ${lowerFirst(ctx.settings.missingFor(spec) ?? `the ${spec.app.name} ${spec.app.term} id and secret`)} in Settings (/settings) first.`);
  const state = await remember(flow);
  return redirect(spec.authorizeUrl(app, `${ctx.app.publicUrl}/auth/${networkId}/callback`, state));
}

export async function finishOAuth(networkId: string, request: Request): Promise<Response> {
  const ctx = await appContext();
  const url = new URL(request.url);
  const flow = await takeFlow(url, networkId);
  const found = networkSpec(networkId);
  const spec = flow && found ? flowSpec(found, ctx.settings.current(), flow) : undefined;
  if (!flow || !spec) return back(networkId, 'This authorisation is stale or was not started here: try again.');
  const app = ctx.settings.oauthApp(spec);
  const code = url.searchParams.get('code');
  const name = network(networkId)?.name ?? networkId;
  if (code && ctx.preview) return finishPreview(networkId, flow, code);
  if (!code || !app) return back(networkId, `${name} did not authorise Shipcast: ${spec.errorParams.map((p) => url.searchParams.get(p)).find(Boolean) ?? 'cancelled'}.`);
  try {
    const accounts = await spec.exchange(app, `${ctx.app.publicUrl}/auth/${networkId}/callback`, code);
    return await connectAll(networkId, flow, accounts);
  } catch (error) {
    return back(networkId, error instanceof Error ? error.message : String(error));
  }
}

/** A preview's callback: the made-up token its consent stands for, kept as a real sign-in keeps one */
async function finishPreview(networkId: string, flow: Flow, code: string, settings: Record<string, string> = {}): Promise<Response> {
  const { preview } = await appContext();
  try {
    const accounts = await preview!.oauth.exchange(networkId, code, flow.label);
    return await connectAll(
      networkId,
      flow,
      accounts.map((a) => ({ ...a, credentials: { ...a.credentials, settings: { ...a.credentials.settings, ...settings } } })),
    );
  } catch (error) {
    return back(networkId, error instanceof Error ? error.message : String(error));
  }
}

/** Keeps every account a sign-in produced, through the one path every connection takes (oauth-flows.ts) */
async function connectAll(networkId: string, flow: Flow, accounts: ConnectedAccount[]): Promise<Response> {
  const deps = await accountDeps();
  return connectAllWith((input) => connectAccount(deps, input), networkId, flow, accounts);
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
