/*
 * What a source of numbers is called on a page: its service and the site it reads, "Search Console ·
 * josegarrido.dev". An account's own label for a source is whatever the connector found to tell it
 * apart (a verified property's address, a Cloudflare site tag, a service account's email), right for
 * telling two apart in a form, wrong as its name. No server imports: the pages use it in the browser.
 */

/** The services' short names, as the owner says them */
export const SOURCE_SERVICE: Readonly<Record<string, string>> = {
  searchConsole: 'Search Console',
  bingWebmaster: 'Bing Webmaster',
  cloudflare: 'Cloudflare',
  umami: 'Umami',
};

/** A site's host without its scheme, `www.` or trailing slash: `https://www.example.com/` → `example.com` */
export function siteHost(site: string | null | undefined): string | null {
  if (!site) return null;
  try {
    return new URL(site.includes('://') ? site : `https://${site}`).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** A source's name, "<Service> · <host>"; null for a network that is not a site's source (its own label stands) */
export function sourceName(networkId: string, site: string | null | undefined): string | null {
  const service = SOURCE_SERVICE[networkId];
  if (!service) return null;
  const host = siteHost(site);
  return host ? `${service} · ${host}` : service;
}
