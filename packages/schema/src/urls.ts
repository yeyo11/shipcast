/**
 * The picture's URL, only when it is plain https: the app renders it in an <img>, so a `javascript:`
 * or an `http:` address from a network's answer never reaches the page. Here, in the domain, so the
 * connectors that read such addresses and the app's server functions that show them check them alike.
 */
export function imageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2000) return undefined;
  try {
    return new URL(value).protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}
