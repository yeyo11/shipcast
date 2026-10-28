import { connectAccount, type AccountDeps, type Connected } from './accounts.ts';
import { youtubeCredentials } from './channels/youtube.ts';

/** Why a token file was not imported, in words that never quote the file */
export class YouTubeImportRefused extends Error {}

/**
 * Connects YouTube once from a file holding the owner's OAuth client and a refresh token
 * (`{ "client_id", "client_secret", "refresh_token" }`, as Google's OAuth Playground gives them),
 * through the path the sign-in's callback takes: the same credentials, checked against YouTube
 * before they are kept, the secrets in the secret store. Nothing of the file's content reaches a
 * message: a file that does not parse is refused without quoting it, as the JSON error would.
 */
export async function importYouTubeAccount(deps: AccountDeps, input: { text: string; brand: string; label?: string }): Promise<Connected> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.text);
  } catch {
    throw new YouTubeImportRefused('the file is not JSON: it holds { "client_id", "client_secret", "refresh_token" }');
  }
  const field = (key: string): string => {
    const value = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)[key] : undefined;
    if (typeof value !== 'string' || !value.trim()) throw new YouTubeImportRefused(`the file has no ${key}`);
    return value.trim();
  };
  const credentials = youtubeCredentials({ clientId: field('client_id'), clientSecret: field('client_secret') }, field('refresh_token'));
  return connectAccount(deps, { network: 'youtube', brand: input.brand, ...(input.label && { label: input.label }), credentials });
}
