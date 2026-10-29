import { BingWebmaster, checkProblem, CloudflareAnalytics, GitHubProfile, json, SearchConsole, type Check, type IdentityCache, type ServiceAccount } from '@shipcast/connectors';
import type { Brand, Channel } from '@shipcast/schema';
import { buildContext, envCredentials, MissingField, networkOf, type AnyChannelAdapter, type Connection, type Credentials, type Field, type NetworkSpec, type SourceSpec } from './channels/adapter.ts';
import { CHANNEL_ADAPTERS } from './channels/registry.ts';
import type { TokenBucket } from './redis/ports.ts';


/**
 * Every network Shipcast knows, as the Channels page shows it: each channel's network, from its
 * adapter and its definition (packages/runtime/src/channels), and the networks that are not
 * channels (the sources of numbers and the AI providers), from their entries below.
 */
export interface Network {
  id: string;
  name: string;
  /** The channel it publishes, when it publishes */
  channel?: Channel;
  /** Whether it reads numbers for the dashboard */
  metrics: boolean;
  auth: 'oauth' | 'form';
  /** What the form asks; for OAuth, what is asked before leaving for the network (the instance) */
  fields: Field[];
  /** What Shipcast does with the account, in words */
  permissions: string[];
  /** Where the credential comes from */
  howTo: string;
  /** An AI provider the AI settings can choose, rather than a channel or a source of numbers */
  ai?: boolean;
}

/** An Anthropic key, checked by listing the models it may use */
async function checkAnthropic(apiKey: string, http: typeof fetch): Promise<Check> {
  try {
    const response = await http('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } });
    await json<unknown>('Anthropic', response, 'check');
    return { ok: true, account: 'Anthropic API' };
  } catch (error) {
    return checkProblem(error);
  }
}

/** An OpenAI-compatible server, checked by its model list; the account is named by its host and model */
async function checkOpenAiCompatible(baseUrl: string, model: string, apiKey: string | undefined, http: typeof fetch): Promise<Check> {
  let url: URL;
  try {
    url = new URL(`${baseUrl.replace(/\/+$/, '')}/models`);
  } catch {
    return { ok: false, problem: `${baseUrl} is not a URL` };
  }
  try {
    const response = await http(url, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
    await json<unknown>('The OpenAI-compatible server', response, 'check');
    return { ok: true, account: `${model} on ${url.host}` };
  } catch (error) {
    return checkProblem(error);
  }
}

/**
 * The networks that are not channels: they read numbers for the dashboard (the blog's visits and the
 * search engines'), or write text for the AI settings' tasks. Built here, with no channel to wire.
 */
export const SOURCES: readonly SourceSpec[] = [
  {
    id: 'cloudflare',
    name: 'Blog analytics (Cloudflare)',
    metrics: true,
    auth: 'form',
    fields: [
      { key: 'apiToken', label: 'API token', secret: true, help: 'Account → Account Analytics → Read' },
      { key: 'accountId', label: 'Account id', secret: false },
      { key: 'siteTag', label: 'Web Analytics site tag', secret: false, help: 'Web Analytics → the site → Manage site; not the beacon token' },
    ],
    permissions: ['Reads each article’s visits and where they came from'],
    howTo: 'Cloudflare → My Profile → API Tokens → Create Token with Account Analytics: Read.',
    env: [
      { name: 'CLOUDFLARE_API_TOKEN', key: 'apiToken', secret: true },
      { name: 'CLOUDFLARE_ACCOUNT_ID', key: 'accountId', secret: false },
      { name: 'CLOUDFLARE_WEB_ANALYTICS_SITE_TAG', key: 'siteTag', secret: false },
    ],
    source: { slot: 'blog', configured: 'blog analytics' },
    build: ({ need, fetch }) => {
      const connector = new CloudflareAnalytics({ apiToken: need('apiToken'), accountId: need('accountId'), siteTag: need('siteTag'), fetch });
      return { connector, check: () => connector.check(), profileStats: () => connector.profileStats() };
    },
  },
  {
    id: 'searchConsole',
    name: 'Google Search Console',
    metrics: true,
    auth: 'form',
    fields: [{ key: 'serviceAccount', label: 'Service account JSON key', secret: true, multiline: true }],
    permissions: ['Reads the articles’ search clicks and impressions'],
    howTo: 'A Google Cloud service account with a JSON key, added as a user of the site’s domain property.',
    // A secret cannot be a file: the Action takes the key's text, and `shipcast ci` writes it to one
    env: [{ name: 'GOOGLE_SERVICE_ACCOUNT_FILE', key: 'serviceAccount', secret: true, file: true, actionName: 'GOOGLE_SERVICE_ACCOUNT_JSON' }],
    source: { slot: 'search', configured: 'search console' },
    build: ({ need, brand, fetch }) => {
      let account: ServiceAccount;
      try {
        account = JSON.parse(need('serviceAccount')) as ServiceAccount;
      } catch {
        throw new MissingField('searchConsole needs the service account’s JSON key, as downloaded');
      }
      if (!account.client_email || !account.private_key) throw new MissingField('the JSON key has no client_email or private_key');
      const connector = new SearchConsole({ serviceAccount: account, property: `sc-domain:${new URL(brand.site).host}`, fetch });
      return { connector, check: () => connector.check(), profileStats: () => connector.profileStats() };
    },
  },
  {
    id: 'bingWebmaster',
    name: 'Bing Webmaster Tools',
    metrics: true,
    auth: 'form',
    fields: [{ key: 'apiKey', label: 'API key', secret: true }],
    permissions: ['Reads the articles’ Bing clicks and impressions, and whether Bing has crawled them'],
    howTo: 'Bing Webmaster Tools › Settings › API Access › Generate API Key, for a user who has verified the site.',
    env: [{ name: 'BING_WEBMASTER_API_KEY', key: 'apiKey', secret: true }],
    source: { slot: 'bing', configured: 'bing webmaster' },
    build: ({ need, brand, fetch }) => {
      const connector = new BingWebmaster({ apiKey: need('apiKey'), site: `${new URL(brand.site).origin}/`, fetch });
      return { connector, check: () => connector.check(), profileStats: () => connector.profileStats() };
    },
  },
  // The owner's own GitHub profile, public: the repos' numbers come through the GitHub App instead
  {
    id: 'github',
    name: 'GitHub profile',
    metrics: false,
    auth: 'form',
    fields: [{ key: 'login', label: 'GitHub login', secret: false, placeholder: 'yeyo11', help: 'Whose public profile to read: brand.yml’s github, usually' }],
    permissions: ['Reads your public profile for a review and counts your followers once a day; nothing is written, and no credential is kept'],
    howTo: 'Nothing to create: give your GitHub login, which GitHub’s public API reads without a token.',
    build: ({ need, fetch }) => {
      const connector = new GitHubProfile({ login: need('login'), ...(fetch && { fetch }) });
      return { connector, check: () => connector.check(), profileStats: () => connector.profileStats(), profile: () => connector.profile() };
    },
  },
  // The AI providers are built by the AI settings (ai.ts); here they are only checked
  {
    id: 'anthropic',
    name: 'Anthropic API',
    metrics: false,
    auth: 'form',
    ai: true,
    fields: [{ key: 'apiKey', label: 'API key', secret: true, placeholder: 'sk-ant-…' }],
    permissions: ['Writes the content pack, the article’s translation and pieces, or the writing assistant’s text, for the tasks the AI settings give it'],
    howTo: 'Claude Console → Settings → API keys → Create key. Then choose it per task in the AI settings.',
    build: ({ need, fetch }) => {
      const apiKey = need('apiKey');
      return { connector: undefined, check: () => checkAnthropic(apiKey, fetch ?? globalThis.fetch) };
    },
  },
  {
    id: 'openaiCompatible',
    name: 'OpenAI-compatible server',
    metrics: false,
    auth: 'form',
    ai: true,
    fields: [
      { key: 'baseUrl', label: 'Base URL', secret: false, placeholder: 'http://localhost:11434/v1', help: 'Where its /chat/completions lives' },
      { key: 'model', label: 'Model', secret: false, placeholder: 'qwen3-coder', help: 'Used when a task in the AI settings names none' },
      { key: 'apiKey', label: 'API key', secret: true, optional: true, help: 'Only if the server asks for one' },
    ],
    permissions: ['Writes text for the tasks the AI settings give it, through the chat completions API with a JSON Schema answer'],
    howTo: 'Any server that speaks OpenAI’s chat completions (a local model through Ollama, llama.cpp or vLLM, or a hosted one). Then choose it per task in the AI settings.',
    build: ({ need, get, fetch }) => {
      const baseUrl = need('baseUrl');
      const model = need('model');
      return { connector: undefined, check: () => checkOpenAiCompatible(baseUrl, model, get('apiKey'), fetch ?? globalThis.fetch) };
    },
  },
];

/** A channel's network as the Channels page lists it: its name and channel from its definition */
function channelNetwork(adapter: AnyChannelAdapter, spec: NetworkSpec): Network {
  const { definition } = adapter;
  const provider = adapter.connect.kind === 'account' ? adapter.connect.provider : undefined;
  return {
    id: spec.id,
    name: provider ? `${definition.name} (${provider})` : definition.name,
    channel: definition.id as Channel,
    metrics: adapter.metrics !== undefined,
    auth: spec.auth,
    fields: spec.fields,
    permissions: spec.permissions,
    howTo: spec.howTo,
  };
}

function sourceNetwork(spec: SourceSpec): Network {
  return { id: spec.id, name: spec.name, metrics: spec.metrics, auth: spec.auth, fields: spec.fields, permissions: spec.permissions, howTo: spec.howTo, ...(spec.ai && { ai: true }) };
}

/**
 * The catalog from a list of channel adapters: the channels' networks in the adapters' order, then
 * the sources'. NETWORKS is this of the registry; a test hands in a channel added.
 */
export function catalogOf(adapters: readonly AnyChannelAdapter[]): Network[] {
  return [
    ...adapters.flatMap((a) => {
      const spec = networkOf(a);
      return spec ? [channelNetwork(a, spec)] : [];
    }),
    ...SOURCES.map(sourceNetwork),
  ];
}

export const NETWORKS: readonly Network[] = catalogOf(CHANNEL_ADAPTERS);

export function network(id: string): Network | undefined {
  return NETWORKS.find((n) => n.id === id);
}

/** Every network's own spec, the channels' in the registry's order and then the sources' */
export const NETWORK_SPECS: readonly NetworkSpec[] = [...CHANNEL_ADAPTERS.flatMap((a) => networkOf(a) ?? []), ...SOURCES];

/** Every network's own spec, a channel's or a source's, by the account's network id */
export function networkSpec(id: string, adapters: readonly AnyChannelAdapter[] = CHANNEL_ADAPTERS): NetworkSpec | undefined {
  for (const adapter of adapters) {
    const spec = networkOf(adapter);
    if (spec?.id === id) return spec;
  }
  return SOURCES.find((s) => s.id === id);
}

/** The channel adapter whose accounts are of this network (`brevo` is the newsletter's) */
export function adapterOfNetwork(id: string, adapters: readonly AnyChannelAdapter[] = CHANNEL_ADAPTERS): AnyChannelAdapter | undefined {
  return adapters.find((a) => networkOf(a)?.id === id);
}

/** The connector one network's account builds, with what every network offers: its check and its account */
export type Built = Connection;

/**
 * Builds a network's connector from an account's credentials. A missing value throws `MissingField`,
 * so an account is never half-built; `http` replaces fetch in tests.
 */
export function buildConnector(
  id: string,
  credentials: Credentials,
  brand: Brand,
  http: typeof fetch = globalThis.fetch,
  options: { adapters?: readonly AnyChannelAdapter[]; buckets?: TokenBucket; cache?: IdentityCache } = {},
): Built {
  const spec = networkSpec(id, options.adapters);
  if (!spec) throw new MissingField(`${id} has nothing to connect`);
  return spec.build(buildContext(id, credentials, brand, http, options.buckets, options.cache));
}

/**
 * The credentials `.env` holds for a network, the way Shipcast was configured before the app: the
 * fallback for the brand `.env` speaks for, and what "Import from .env" moves into the keychain.
 */
export function credentialsFromEnv(
  id: string,
  env: NodeJS.ProcessEnv,
  brand: Brand,
  readFile: (path: string) => string,
  adapters: readonly AnyChannelAdapter[] = CHANNEL_ADAPTERS,
): Credentials | undefined {
  const variables = networkSpec(id, adapters)?.env;
  return variables ? envCredentials(variables, env, brand, readFile) : undefined;
}
