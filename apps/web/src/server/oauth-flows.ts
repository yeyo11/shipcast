import { network, oauthSpecOf, type ConnectedAccount, type Connected, type NetworkSpec, type OAuthSpec, type SettingsValues } from '@shipcast/runtime';
import { processState, type OneTimeStore } from '@shipcast/runtime/redis';

/*
 * The parts of a sign-in's round trip that hold no context of the app's: what a flow keeps between
 * `/auth/<network>` and its callback, which spec each end uses, and how the accounts it produced are
 * kept. channels.server.ts runs them with the app's context; the tests with their own store.
 */

/**
 * An OAuth sign-in in flight, by state: which network, brand and instance it is for, ten minutes and
 * good once. In the process's one-time store: memory, or Redis when the process has it, so a sign-in
 * started on one replica finishes on whichever one the network's redirect reaches.
 */
export interface Flow {
  network: string;
  brand: string;
  instance?: string;
  label?: string;
  /** The sign-in it started with, for a network that has several: its callback finishes that one */
  variant?: string;
}
const OAUTH_NAMESPACE = 'oauth-state';

export function oauthFlows(store: OneTimeStore = processState().shared.oneTime) {
  return {
    remember(entry: Flow): Promise<string> {
      // JSON keeps no undefined: the fields not given are left out
      const value: Record<string, string> = { network: entry.network, brand: entry.brand };
      if (entry.instance !== undefined) value.instance = entry.instance;
      if (entry.label !== undefined) value.label = entry.label;
      if (entry.variant !== undefined) value.variant = entry.variant;
      return store.put(OAUTH_NAMESPACE, value, 10 * 60);
    },

    /** The flow a callback belongs to, taken once: a state is never good twice, on any replica */
    async take(url: URL, network: string): Promise<Flow | undefined> {
      const state = url.searchParams.get('state') ?? '';
      if (!state) return undefined;
      const flow = await store.take<Record<string, string>>(OAUTH_NAMESPACE, state);
      if (!flow || flow.network !== network || flow.brand === undefined) return undefined;
      return {
        network,
        brand: flow.brand,
        ...(flow.instance !== undefined && { instance: flow.instance }),
        ...(flow.label !== undefined && { label: flow.label }),
        ...(flow.variant !== undefined && { variant: flow.variant }),
      };
    },
  };
}

/** The sign-in Settings chooses for the network, and the flow that remembers which one it was */
export function startFlow(spec: NetworkSpec, settings: SettingsValues, params: URLSearchParams): { spec: OAuthSpec; flow: Flow } | undefined {
  const signIn = oauthSpecOf(spec, settings);
  if (!signIn) return undefined;
  const flow: Flow = { network: spec.id, brand: params.get('brand') ?? 'personal', label: params.get('label') ?? undefined, variant: signIn.variant };
  return { spec: signIn.spec, flow };
}

/** The spec a callback finishes with: the variant its flow started, whatever Settings says now */
export function flowSpec(spec: NetworkSpec, settings: SettingsValues, flow: Flow): OAuthSpec | undefined {
  return oauthSpecOf(spec, settings, flow.variant)?.spec;
}

export const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

/** A failed flow goes back to the network's page, which shows the problem */
export const back = (network: string, problem: string) => redirect(`/channels/${network}?${new URLSearchParams({ problem })}`);

/**
 * A connected account lands on the channels list, scrolled to it and focused; what else went wrong
 * in the same sign-in (another account refused) comes along, for the page to say
 */
export const connected = (account: { id: number; identity: string | null; label: string }, problem?: string) =>
  redirect(`/channels?${new URLSearchParams({ connected: `Connected ${account.identity ?? account.label}`, focus: String(account.id), ...(problem && { problem }) })}`);

/** What keeping one account takes: `connectAccount` with the app's dependencies */
export type Connect = (input: { network: string; brand: string; label: string | undefined; credentials: ConnectedAccount['credentials'] }) => Promise<Connected>;

/**
 * Keeps every account a sign-in produced (Meta's consent may share several Pages or Instagram
 * accounts at once), each through the one path every connection takes: checked first, its secrets in
 * the keychain. The label the owner typed names one account, never several. The browser lands on the
 * first one connected, told about any other that was refused; one that fails does not undo the others.
 */
export async function connectAll(connect: Connect, networkId: string, flow: { brand: string; label?: string }, accounts: ConnectedAccount[]): Promise<Response> {
  if (accounts.length === 0) return back(networkId, `${network(networkId)?.name ?? networkId} shared no account with Shipcast.`);
  const label = accounts.length === 1 ? flow.label : undefined;
  let first: Parameters<typeof connected>[0] | undefined;
  const problems: string[] = [];
  for (const account of accounts) {
    const result = await connect({ network: networkId, brand: flow.brand, label: label ?? account.label, credentials: account.credentials });
    if (result.ok) first ??= result.account;
    else problems.push(result.problem);
  }
  if (!first) return back(networkId, problems.join('; '));
  return connected(first, problems.length ? problems.join('; ') : undefined);
}
