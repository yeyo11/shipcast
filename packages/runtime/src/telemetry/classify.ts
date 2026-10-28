/**
 * Which provider an outbound call went to and which of its endpoints, as a label with no secret and
 * few distinct values: the host names the provider, and the path keeps its fixed words while ids,
 * names, tokens and file paths become placeholders. The query string is never kept: some APIs take
 * the access token there.
 */
export interface CallTarget {
  provider: string;
  endpoint: string;
}

const HOSTS: Array<[RegExp, string]> = [
  [/^(api\.|uploads\.)?github\.com$|^raw\.githubusercontent\.com$|^codeload\.github\.com$/, 'github'],
  [/(^|\.)bsky\.(social|network|app)$/, 'bluesky'],
  [/^dev\.to$/, 'devto'],
  [/(^|\.)hashnode\.com$/, 'hashnode'],
  [/^graph\.threads\.(net|com)$/, 'threads'],
  [/^(graph|api)\.instagram\.com$|^graph\.facebook\.com$/, 'instagram'],
  [/(^|\.)linkedin\.com$/, 'linkedin'],
  [/^(discord\.com|discordapp\.com)$/, 'discord'],
  [/^api\.telegram\.org$/, 'telegram'],
  [/(^|\.)reddit\.com$/, 'reddit'],
  [/(^|\.)brevo\.com$/, 'brevo'],
  [/^api\.cloudflare\.com$/, 'cloudflare'],
  [/(^|\.)googleapis\.com$/, 'google'],
  [/(^|\.)bing\.com$/, 'bing'],
  [/^api\.anthropic\.com$/, 'anthropic'],
  [/^api\.openai\.com$/, 'openai'],
];

// A path segment that names one thing rather than a kind of thing: has a digit and is long, or is
// long and opaque. Short words (`pulls`, `statuses`, `v1`) stay
const OPAQUE = /^(?=.*\d).{6,}$|^[A-Za-z0-9_-]{24,}$|^[0-9a-f-]{16,}$/i;
const NUMBER = /^\d+$/;
// Telegram puts the bot's token in the path: /bot<id>:<secret>/sendMessage
const TELEGRAM_BOT = /^bot\d+:[^/]+$/;

/** The provider a host belongs to: a known API's name, `mastodon` for any instance's API, else the host itself */
function providerOf(url: URL): string {
  const host = url.hostname.toLowerCase();
  for (const [pattern, name] of HOSTS) if (pattern.test(host)) return name;
  if (/^\/api\/v[12]\//.test(url.pathname) || url.pathname === '/oauth/token') return 'mastodon';
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return 'local';
  return host;
}

/** GitHub's paths carry an owner and a repository, then a file path or a ref of any length */
function githubEndpoint(segments: string[], host: string): string[] {
  if (host === 'raw.githubusercontent.com') return [':owner', ':repo', ':ref', '*'];
  const out = [...segments];
  if (out[0] === 'repos' && out.length >= 3) {
    out[1] = ':owner';
    out[2] = ':repo';
    // contents/<path>, git/ref(s)/heads/<branch>, compare/<a>...<b>: what follows is a name, not a route
    const tail = out.findIndex((s, i) => i > 2 && ['contents', 'compare', 'commits', 'branches', 'tags', 'readme'].includes(s));
    if (tail > 0 && out.length > tail + 1) out.splice(tail + 1, out.length, '*');
    const git = out.indexOf('git');
    if (git > 2 && (out[git + 1] === 'ref' || out[git + 1] === 'refs' || out[git + 1] === 'matching-refs') && out.length > git + 2) out.splice(git + 2, out.length, '*');
  }
  if ((out[0] === 'users' || out[0] === 'orgs') && out.length >= 2) out[1] = ':name';
  return out;
}

export function classify(input: string | URL): CallTarget {
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : input;
  } catch {
    return { provider: 'invalid', endpoint: '/' };
  }
  const provider = providerOf(url);
  let segments = url.pathname.split('/').filter(Boolean);
  if (provider === 'github') segments = githubEndpoint(segments, url.hostname);
  if (provider === 'mastodon' && segments[0] === 'api' && segments[2] === 'accounts' && segments[3] && !NUMBER.test(segments[3])) segments[3] = segments[3] === 'verify_credentials' || segments[3] === 'update_credentials' || segments[3] === 'lookup' ? segments[3] : ':id';
  const endpoint = segments
    .map((s) => {
      if (s.startsWith(':') || s === '*') return s;
      if (TELEGRAM_BOT.test(s)) return 'bot:token';
      // An API's version (Meta's v21.0, Mastodon's v2) is a route, and worth keeping apart
      if (/^v\d+(\.\d+)?$/.test(s)) return s;
      if (NUMBER.test(s)) return ':n';
      if (OPAQUE.test(s)) return ':id';
      // A handle, a file name, an address: anything with characters an API route never has
      if (/[@.%~]/.test(s) && !/^[a-z]+\.[a-z]+(\.[a-zA-Z]+)*$/.test(s)) return ':id';
      return s;
    })
    .join('/');
  return { provider, endpoint: `/${endpoint}`.slice(0, 160) };
}
