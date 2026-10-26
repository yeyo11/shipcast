import {
  BingWebmaster,
  Bluesky,
  Brevo,
  checkProblem,
  CloudflareAnalytics,
  Devto,
  Discord,
  Hashnode,
  Instagram,
  json,
  LinkedIn,
  Reddit,
  Mastodon,
  okCheck,
  SearchConsole,
  Telegram,
  Threads,
  statsOf,
  type Check,
  type ProfileStats,
  type ServiceAccount,
} from '@shipcast/connectors';
import type { Brand, Channel } from '@shipcast/schema';

/** A value an account needs: public ones are kept in the registry, secret ones in the keychain. */
export interface Field {
  key: string;
  label: string;
  secret: boolean;
  optional?: boolean;
  placeholder?: string;
  help?: string;
  /** A pasted file, such as a service account's JSON key */
  multiline?: boolean;
}

/**
 * Every network Shipcast knows, as the Channels page shows it. A network is a connector plus one
 * entry here.
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

export const NETWORKS: readonly Network[] = [
  {
    id: 'devto',
    name: 'dev.to',
    channel: 'devto',
    metrics: true,
    auth: 'form',
    fields: [{ key: 'apiKey', label: 'API key', secret: true }],
    permissions: ['Publishes the English article with the blog as its canonical URL', 'Reads its views, reactions and comments'],
    howTo: 'dev.to → Settings → Extensions → DEV Community API Keys → Generate API Key.',
  },
  {
    id: 'bluesky',
    name: 'Bluesky',
    channel: 'bluesky',
    metrics: true,
    auth: 'form',
    fields: [
      { key: 'handle', label: 'Handle', secret: false, placeholder: 'name.bsky.social' },
      { key: 'appPassword', label: 'App password', secret: true, help: 'Never the account password' },
    ],
    permissions: ['Posts with a link card', 'Reads likes, reposts and replies (public)'],
    howTo: 'Bluesky → Settings → Privacy and security → App passwords → Add App Password.',
  },
  {
    id: 'mastodon',
    name: 'Mastodon',
    channel: 'mastodon',
    metrics: true,
    auth: 'oauth',
    fields: [
      { key: 'instance', label: 'Instance', secret: false, placeholder: 'https://mastodon.social' },
      {
        key: 'accessToken',
        label: 'Access token',
        secret: true,
        optional: true,
        help: 'Only to paste one instead of authorising: Preferences → Development → an app with read and write scopes',
      },
    ],
    permissions: ['Posts a public status with an image (write:statuses, write:media)', 'Reads its favourites, boosts and replies (read:statuses)'],
    howTo: 'Name your instance: Shipcast registers itself there and sends you to authorise it. Or paste an access token.',
  },
  {
    id: 'instagram',
    name: 'Instagram',
    channel: 'instagram',
    metrics: true,
    auth: 'oauth',
    fields: [],
    permissions: [
      'Publishes the carousel and the story (instagram_business_content_publish)',
      'Comments on its own post (instagram_business_manage_comments)',
      'Reads reach and interactions (instagram_business_manage_insights)',
    ],
    howTo: 'A professional (Creator or Business) account. Shipcast sends you to Instagram to authorise it; the token is renewed every 30 days.',
  },
  {
    id: 'threads',
    name: 'Threads',
    channel: 'threads',
    metrics: true,
    auth: 'oauth',
    fields: [],
    permissions: [
      'Publishes a post with the launch image (threads_content_publish) and deletes it when you ask (threads_delete)',
      'Reads the replies and answers them when you approve (threads_read_replies, threads_manage_replies)',
      'Reads views, likes, replies and reposts (threads_manage_insights)',
    ],
    howTo: 'Needs your Meta app’s Threads use case, its app id and secret set in Settings. Shipcast sends you to Threads to authorise it; the token is renewed every 30 days.',
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    channel: 'linkedin',
    metrics: false,
    auth: 'oauth',
    fields: [],
    permissions: [
      'Publishes a post on your personal profile sharing the article, and deletes it when you ask (w_member_social)',
      'Reads your name and picture to show the account (openid, profile)',
      'No numbers and no comments: LinkedIn keeps them behind its Community Management API, for approved companies only',
    ],
    howTo: 'Needs your LinkedIn app with Sign In with LinkedIn using OpenID Connect and Share on LinkedIn, its client id and secret set in Settings. The token lasts 60 days; connect again when it runs out.',
  },
  {
    id: 'reddit',
    name: 'Reddit',
    channel: 'reddit',
    metrics: false,
    auth: 'oauth',
    fields: [],
    permissions: [
      'Publishes one text post per subreddit in launch.yml, linking the article, and deletes it when you ask (submit)',
      'Reads your own submissions, to find a post whose answer was lost instead of posting it twice (read)',
      'Reads your name, picture and karma (identity)',
    ],
    howTo: 'Needs your Reddit app (a "web app" at reddit.com/prefs/apps, whose API access Reddit has approved), its client id and secret set in Settings, and its redirect uri set to this app’s /auth/reddit/callback. Shipcast sends you to Reddit to authorise it once; the account stays connected.',
  },
  {
    id: 'brevo',
    name: 'Newsletter (Brevo)',
    channel: 'newsletter',
    metrics: true,
    auth: 'form',
    fields: [{ key: 'apiKey', label: 'API key', secret: true }],
    permissions: ['Creates and sends one campaign per language', 'Reads sends, opens, clicks and unsubscribes'],
    howTo: 'Brevo → Settings → SMTP & API → API keys → Generate a new API key. The sender and lists live in brand.yml.',
  },
  {
    id: 'hashnode',
    name: 'Hashnode',
    channel: 'hashnode',
    metrics: true,
    auth: 'form',
    fields: [
      { key: 'token', label: 'Personal access token', secret: true },
      { key: 'publicationHost', label: 'Publication host', secret: false, placeholder: 'name.hashnode.dev' },
    ],
    permissions: ['Republishes the English article with the blog as its original URL', 'Reads views, reactions and comments'],
    howTo: 'Hashnode → Account settings → Developer → Generate new token. Hashnode’s API may need the publication on its Pro plan.',
  },
  {
    id: 'telegram',
    name: 'Telegram',
    channel: 'telegram',
    metrics: false,
    auth: 'form',
    fields: [
      { key: 'botToken', label: 'Bot token', secret: true },
      { key: 'chatId', label: 'Chat or channel', secret: false, placeholder: '@channel or -100…', help: 'Where posts go; notifications go there too unless a notification chat is set' },
      { key: 'notifyChatId', label: 'Notification chat', secret: false, optional: true, help: 'Your private chat with the bot, for “drafts are waiting” messages' },
    ],
    permissions: ['Posts to the channel', 'Tells you when drafts are waiting, published or failed'],
    howTo: 'Talk to @BotFather, send /newbot and copy the token; add the bot as an admin of the channel.',
  },
  {
    id: 'discord',
    name: 'Discord',
    channel: 'discord',
    metrics: false,
    auth: 'form',
    fields: [{ key: 'webhookUrl', label: 'Webhook URL', secret: true }],
    permissions: ['Posts to one channel through its webhook'],
    howTo: 'Discord → the channel’s settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.',
  },
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
  },
  {
    id: 'searchConsole',
    name: 'Google Search Console',
    metrics: true,
    auth: 'form',
    fields: [{ key: 'serviceAccount', label: 'Service account JSON key', secret: true, multiline: true }],
    permissions: ['Reads the articles’ search clicks and impressions'],
    howTo: 'A Google Cloud service account with a JSON key, added as a user of the site’s domain property.',
  },
  {
    id: 'bingWebmaster',
    name: 'Bing Webmaster Tools',
    metrics: true,
    auth: 'form',
    fields: [{ key: 'apiKey', label: 'API key', secret: true }],
    permissions: ['Reads the articles’ Bing clicks and impressions, and whether Bing has crawled them'],
    howTo: 'Bing Webmaster Tools › Settings › API Access › Generate API Key, for a user who has verified the site.',
  },
  {
    id: 'anthropic',
    name: 'Anthropic API',
    metrics: false,
    auth: 'form',
    ai: true,
    fields: [{ key: 'apiKey', label: 'API key', secret: true, placeholder: 'sk-ant-…' }],
    permissions: ['Writes the content pack, the article’s translation and pieces, or the writing assistant’s text, for the tasks the AI settings give it'],
    howTo: 'Claude Console → Settings → API keys → Create key. Then choose it per task in the AI settings.',
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
  },
];

export function network(id: string): Network | undefined {
  return NETWORKS.find((n) => n.id === id);
}

/** What an account is made of when it is built: its public settings and its secrets together. */
export interface Credentials {
  settings: Record<string, string>;
  secrets: Record<string, string>;
}

export class MissingField extends Error {}

function need(values: Record<string, string>, key: string, network: string): string {
  const value = values[key]?.trim();
  if (!value) throw new MissingField(`${network} needs ${key}`);
  return value;
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

/** The connectors one network's account builds, whichever of them the network has. */
export interface Built {
  check(): Promise<Check>;
  /** The account's own followers, following and posts, on the networks whose API counts them */
  profileStats?(): Promise<ProfileStats>;
  devto?: Devto;
  bluesky?: Bluesky;
  mastodon?: Mastodon;
  instagram?: Instagram;
  threads?: Threads;
  linkedin?: LinkedIn;
  reddit?: Reddit;
  brevo?: Brevo;
  hashnode?: Hashnode;
  telegram?: Telegram;
  discord?: Discord;
  cloudflare?: CloudflareAnalytics;
  searchConsole?: SearchConsole;
  bing?: BingWebmaster;
}

/**
 * Builds a network's connector from an account's credentials. A missing value throws `MissingField`,
 * so an account is never half-built; `http` replaces fetch in tests.
 */
export function buildConnector(id: string, credentials: Credentials, brand: Brand, http: typeof fetch = globalThis.fetch): Built {
  const all = { ...credentials.settings, ...credentials.secrets };
  const v = (key: string) => need(all, key, id);
  switch (id) {
    case 'devto': {
      const devto = new Devto({ apiKey: v('apiKey'), fetch: http });
      return { devto, check: () => devto.check(), profileStats: () => devto.profileStats() };
    }
    case 'bluesky': {
      const bluesky = new Bluesky({ identifier: v('handle'), appPassword: v('appPassword'), fetch: http });
      return { bluesky, check: () => bluesky.check(), profileStats: () => bluesky.profileStats() };
    }
    case 'mastodon': {
      const mastodon = new Mastodon({ instance: v('instance'), accessToken: v('accessToken'), fetch: http });
      return { mastodon, check: () => mastodon.check(), profileStats: () => mastodon.profileStats() };
    }
    case 'instagram': {
      const instagram = new Instagram({ userId: v('userId'), accessToken: v('accessToken'), fetch: http });
      return { instagram, check: () => instagram.check(), profileStats: () => instagram.profileStats() };
    }
    case 'threads': {
      const threads = new Threads({ userId: v('userId'), accessToken: v('accessToken'), fetch: http });
      return { threads, check: () => threads.check(), profileStats: () => threads.profileStats() };
    }
    case 'linkedin': {
      const linkedin = new LinkedIn({ personId: v('personId'), accessToken: v('accessToken'), expiresAt: all.expiresAt || undefined, fetch: http });
      return { linkedin, check: () => linkedin.check() };
    }
    case 'reddit': {
      // The app's client is kept with the account: the refresh token is only good with the app that issued it
      const reddit = new Reddit({ clientId: v('clientId'), clientSecret: v('clientSecret'), refreshToken: v('refreshToken'), username: v('username'), fetch: http });
      return { reddit, check: () => reddit.check(), profileStats: () => reddit.profileStats() };
    }
    case 'brevo': {
      const brevo = new Brevo({ apiKey: v('apiKey'), fetch: http });
      return { brevo, check: () => brevo.check(), profileStats: () => brevo.profileStats() };
    }
    case 'hashnode': {
      const hashnode = new Hashnode({ token: v('token'), publicationHost: all.publicationHost || undefined, fetch: http });
      return { hashnode, check: () => hashnode.check(), profileStats: () => hashnode.profileStats() };
    }
    case 'telegram': {
      const telegram = new Telegram({ botToken: v('botToken'), chatId: v('chatId'), fetch: http });
      return { telegram, check: () => telegram.check(), profileStats: () => telegram.profileStats() };
    }
    case 'discord': {
      const discord = new Discord({ webhookUrl: v('webhookUrl'), fetch: http });
      return { discord, check: () => discord.check() };
    }
    case 'cloudflare': {
      const cloudflare = new CloudflareAnalytics({ apiToken: v('apiToken'), accountId: v('accountId'), siteTag: v('siteTag'), fetch: http });
      return { cloudflare, check: () => cloudflare.check(), profileStats: () => cloudflare.profileStats() };
    }
    case 'searchConsole': {
      let account: ServiceAccount;
      try {
        account = JSON.parse(v('serviceAccount')) as ServiceAccount;
      } catch {
        throw new MissingField('searchConsole needs the service account’s JSON key, as downloaded');
      }
      if (!account.client_email || !account.private_key) throw new MissingField('the JSON key has no client_email or private_key');
      const searchConsole = new SearchConsole({ serviceAccount: account, property: `sc-domain:${new URL(brand.site).host}`, fetch: http });
      return { searchConsole, check: () => searchConsole.check(), profileStats: () => searchConsole.profileStats() };
    }
    case 'bingWebmaster': {
      const bing = new BingWebmaster({ apiKey: v('apiKey'), site: `${new URL(brand.site).origin}/`, fetch: http });
      return { bing, check: () => bing.check(), profileStats: () => bing.profileStats() };
    }
    // The AI providers are built by the AI settings (ai.ts); here they are only checked
    case 'anthropic': {
      const apiKey = v('apiKey');
      return { check: () => checkAnthropic(apiKey, http) };
    }
    case 'openaiCompatible': {
      const baseUrl = v('baseUrl');
      const model = v('model');
      return { check: () => checkOpenAiCompatible(baseUrl, model, all.apiKey || undefined, http) };
    }
    default:
      throw new MissingField(`${id} has nothing to connect`);
  }
}

/** `https://bsky.app/profile/yeyo11.bsky.social` → `yeyo11.bsky.social` */
export function blueskyHandle(profile: string | undefined): string | undefined {
  return profile ? /\/profile\/([^/?#]+)/.exec(profile)?.[1] : undefined;
}

/** `https://mastodon.social/@yeyo11` → `https://mastodon.social` */
export function mastodonInstance(profile: string | undefined): string | undefined {
  return profile ? new URL(profile).origin : undefined;
}

/**
 * The credentials `.env` holds for a network, the way Shipcast was configured before the app: the
 * fallback for the brand `.env` speaks for, and what "Import from .env" moves into the keychain.
 */
export function credentialsFromEnv(id: string, env: NodeJS.ProcessEnv, brand: Brand, readFile: (path: string) => string): Credentials | undefined {
  const has = (...names: string[]) => names.every((n) => env[n]?.trim());
  switch (id) {
    case 'devto':
      return has('DEVTO_API_KEY') ? { settings: {}, secrets: { apiKey: env.DEVTO_API_KEY! } } : undefined;
    case 'bluesky': {
      const handle = env.BLUESKY_HANDLE || blueskyHandle(brand.handles.bluesky);
      return handle && has('BLUESKY_APP_PASSWORD') ? { settings: { handle }, secrets: { appPassword: env.BLUESKY_APP_PASSWORD! } } : undefined;
    }
    case 'mastodon': {
      const instance = env.MASTODON_INSTANCE || mastodonInstance(brand.handles.mastodon);
      return instance && has('MASTODON_ACCESS_TOKEN') ? { settings: { instance }, secrets: { accessToken: env.MASTODON_ACCESS_TOKEN! } } : undefined;
    }
    case 'instagram':
      return has('INSTAGRAM_USER_ID', 'INSTAGRAM_ACCESS_TOKEN')
        ? { settings: { userId: env.INSTAGRAM_USER_ID! }, secrets: { accessToken: env.INSTAGRAM_ACCESS_TOKEN! } }
        : undefined;
    case 'brevo':
      return has('BREVO_API_KEY') ? { settings: {}, secrets: { apiKey: env.BREVO_API_KEY! } } : undefined;
    case 'hashnode':
      return has('HASHNODE_TOKEN') ? { settings: { publicationHost: env.HASHNODE_PUBLICATION_HOST ?? '' }, secrets: { token: env.HASHNODE_TOKEN! } } : undefined;
    case 'telegram':
      return has('TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID')
        ? { settings: { chatId: env.TELEGRAM_CHAT_ID!, notifyChatId: env.TELEGRAM_NOTIFY_CHAT_ID ?? '' }, secrets: { botToken: env.TELEGRAM_BOT_TOKEN! } }
        : undefined;
    case 'discord':
      return has('DISCORD_WEBHOOK_URL') ? { settings: {}, secrets: { webhookUrl: env.DISCORD_WEBHOOK_URL! } } : undefined;
    case 'cloudflare':
      return has('CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_WEB_ANALYTICS_SITE_TAG')
        ? {
            settings: { accountId: env.CLOUDFLARE_ACCOUNT_ID!, siteTag: env.CLOUDFLARE_WEB_ANALYTICS_SITE_TAG! },
            secrets: { apiToken: env.CLOUDFLARE_API_TOKEN! },
          }
        : undefined;
    case 'searchConsole':
      return has('GOOGLE_SERVICE_ACCOUNT_FILE') ? { settings: {}, secrets: { serviceAccount: readFile(env.GOOGLE_SERVICE_ACCOUNT_FILE!) } } : undefined;
    case 'bingWebmaster':
      return has('BING_WEBMASTER_API_KEY') ? { settings: {}, secrets: { apiKey: env.BING_WEBMASTER_API_KEY! } } : undefined;
    default:
      return undefined;
  }
}
