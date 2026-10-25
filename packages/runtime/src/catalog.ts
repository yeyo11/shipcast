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
  Mastodon,
  SearchConsole,
  Telegram,
  type Check,
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
 * entry here; `auth: 'none'` marks a channel with no API to post through (drafts only).
 */
export interface Network {
  id: string;
  name: string;
  /** The channel it publishes, when it publishes */
  channel?: Channel;
  /** Whether it reads numbers for the dashboard */
  metrics: boolean;
  auth: 'oauth' | 'form' | 'none';
  /** What the form asks; for OAuth, what is asked before leaving for the network (the instance) */
  fields: Field[];
  /** What Shipcast does with the account, in words */
  permissions: string[];
  /** Where the credential comes from */
  howTo: string;
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
    id: 'github',
    name: 'GitHub',
    metrics: true,
    auth: 'form',
    fields: [{ key: 'token', label: 'Fine-grained token', secret: true }],
    permissions: ['Reads stars, forks and watchers', 'Reads the repo’s traffic (needs Administration: read)'],
    howTo: 'GitHub → Settings → Developer settings → Fine-grained tokens, with read access to the repos you launch.',
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
    id: 'hackerNews',
    name: 'Hacker News',
    channel: 'hackerNews',
    metrics: false,
    auth: 'none',
    fields: [],
    permissions: ['None: Hacker News has no API to post. Shipcast writes the Show HN draft for you to post'],
    howTo: 'Turn on hackerNews: manual in a project’s launch.yml.',
  },
  {
    id: 'productHunt',
    name: 'Product Hunt',
    channel: 'productHunt',
    metrics: false,
    auth: 'none',
    fields: [],
    permissions: ['None: Product Hunt’s API cannot create launches. Shipcast writes the launch kit for you'],
    howTo: 'Turn on productHunt: manual in a project’s launch.yml.',
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

/** A GitHub token's owner, checked without the engine's client */
async function checkGitHub(token: string, http: typeof fetch): Promise<Check> {
  try {
    const response = await http('https://api.github.com/user', {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'shipcast' },
    });
    const user = await json<{ login: string }>('GitHub', response, 'check');
    return { ok: true, account: `@${user.login}` };
  } catch (error) {
    return checkProblem(error);
  }
}

/** The connectors one network's account builds, whichever of them the network has. */
export interface Built {
  check(): Promise<Check>;
  devto?: Devto;
  bluesky?: Bluesky;
  mastodon?: Mastodon;
  instagram?: Instagram;
  brevo?: Brevo;
  hashnode?: Hashnode;
  telegram?: Telegram;
  discord?: Discord;
  github?: { token: string };
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
      return { devto, check: () => devto.check() };
    }
    case 'bluesky': {
      const bluesky = new Bluesky({ identifier: v('handle'), appPassword: v('appPassword'), fetch: http });
      return { bluesky, check: () => bluesky.check() };
    }
    case 'mastodon': {
      const mastodon = new Mastodon({ instance: v('instance'), accessToken: v('accessToken'), fetch: http });
      return { mastodon, check: () => mastodon.check() };
    }
    case 'instagram': {
      const instagram = new Instagram({ userId: v('userId'), accessToken: v('accessToken'), fetch: http });
      return { instagram, check: () => instagram.check() };
    }
    case 'brevo': {
      const brevo = new Brevo({ apiKey: v('apiKey'), fetch: http });
      return { brevo, check: () => brevo.check() };
    }
    case 'hashnode': {
      const hashnode = new Hashnode({ token: v('token'), publicationHost: all.publicationHost || undefined, fetch: http });
      return { hashnode, check: () => hashnode.check() };
    }
    case 'telegram': {
      const telegram = new Telegram({ botToken: v('botToken'), chatId: v('chatId'), fetch: http });
      return { telegram, check: () => telegram.check() };
    }
    case 'discord': {
      const discord = new Discord({ webhookUrl: v('webhookUrl'), fetch: http });
      return { discord, check: () => discord.check() };
    }
    case 'github': {
      const token = v('token');
      return { github: { token }, check: () => checkGitHub(token, http) };
    }
    case 'cloudflare': {
      const cloudflare = new CloudflareAnalytics({ apiToken: v('apiToken'), accountId: v('accountId'), siteTag: v('siteTag'), fetch: http });
      return { cloudflare, check: () => cloudflare.check() };
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
      return { searchConsole, check: () => searchConsole.check() };
    }
    case 'bingWebmaster': {
      const bing = new BingWebmaster({ apiKey: v('apiKey'), site: `${new URL(brand.site).origin}/`, fetch: http });
      return { bing, check: () => bing.check() };
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
