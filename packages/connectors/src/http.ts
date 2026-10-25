/** A connector's failure: which network, what it answered, and whether trying again could help. */
export class ConnectorError extends Error {
  readonly network: string;
  readonly status: number | undefined;
  readonly #retryable: boolean | undefined;

  /** `retryable` overrides the status, for a failure whose retry would repeat what already happened */
  constructor(network: string, message: string, status?: number, retryable?: boolean) {
    super(`${network}: ${message}`);
    this.network = network;
    this.status = status;
    this.#retryable = retryable;
  }

  /** Rate limits and server errors pass; a refused request will be refused again */
  get retryable(): boolean {
    return this.#retryable ?? (this.status === undefined || this.status === 429 || this.status >= 500);
  }
}

/** A published piece: the network's own id for it, and the URL a person opens. */
export interface Published {
  externalId: string;
  url: string;
}

/** Numbers a network reports for one piece, by name (views, likes, reposts…). */
export type Metrics = Record<string, number>;

/** Reads a JSON answer, turning a non-2xx into a ConnectorError with what the network said. */
export async function json<T>(network: string, response: Response, what: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new ConnectorError(network, `${what}: ${response.status} ${text.slice(0, 300)}`, response.status);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ConnectorError(network, `${what}: the answer is not JSON`, response.status);
  }
}

/**
 * Whether a credential works, in words a person can act on: what the Channels page shows. A working
 * one also brings the profile's picture and name when the same answer has them.
 */
export type Check = { ok: true; account: string; avatarUrl?: string; displayName?: string } | { ok: false; problem: string };

/**
 * An account's own numbers at one moment. Each is left out where the network does not give it;
 * `extra` holds what only that network counts (a Telegram channel's members, GitHub's repos).
 */
export interface ProfileStats {
  followers?: number;
  following?: number;
  posts?: number;
  extra?: Record<string, number>;
}

/**
 * The picture's URL, only when it is plain https: the app renders it in an <img>, so a `javascript:`
 * or an `http:` address from a network's answer never reaches the page.
 */
export function imageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2000) return undefined;
  try {
    return new URL(value).protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps what is a number: networks answer null or leave a count out when it is hidden */
export function counts(values: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(values)) if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  return out;
}

/** Profile stats from a network's answer, leaving out what it did not count */
export function statsOf(main: { followers?: unknown; following?: unknown; posts?: unknown }, extra: Record<string, unknown> = {}): ProfileStats {
  const more = counts(extra);
  return { ...counts(main), ...(Object.keys(more).length > 0 ? { extra: more } : {}) };
}

/** A working check with the profile's picture and name, each only when there is one */
export function okCheck(account: string, profile: { avatarUrl?: unknown; displayName?: unknown } = {}): Check {
  const avatarUrl = imageUrl(profile.avatarUrl);
  const displayName = typeof profile.displayName === 'string' && profile.displayName.trim() ? profile.displayName.trim() : undefined;
  return { ok: true, account, ...(avatarUrl && { avatarUrl }), ...(displayName && { displayName }) };
}

/**
 * Turns a failed check into a sentence: a status code means nothing to the person who has to fix the
 * credential, so the common answers are named for what they mean.
 */
export function checkProblem(error: unknown, rejected?: string): Check {
  if (error instanceof ConnectorError) {
    // Some networks mean something more specific by a refusal, which the connector knows best
    if (rejected && (error.status === 401 || error.status === 403)) return { ok: false, problem: rejected };
    if (error.status === 401) return { ok: false, problem: `${error.network} rejected the credential: it is wrong, revoked or expired` };
    if (error.status === 403) return { ok: false, problem: `${error.network} accepted the credential but it lacks a permission Shipcast needs` };
    if (error.status === 404) return { ok: false, problem: `${error.network} does not know that account or address` };
    if (error.status === 429) return { ok: false, problem: `${error.network} is rate limiting: try again in a few minutes` };
    if (error.status !== undefined && error.status >= 500) return { ok: false, problem: `${error.network} is having trouble (${error.status}): try again later` };
    return { ok: false, problem: error.message };
  }
  return { ok: false, problem: `could not reach the network: ${error instanceof Error ? error.message : String(error)}` };
}

/**
 * Reads an answer whose body does not matter (a 204, a commit record), turning a non-2xx into a
 * ConnectorError the way `json` does.
 */
export async function expectOk(network: string, response: Response, what: string): Promise<void> {
  if (response.ok) return;
  const text = await response.text().catch(() => '');
  throw new ConnectorError(network, `${what}: ${response.status} ${text.slice(0, 300)}`, response.status);
}

/**
 * A connector that can change a piece it published, in place. `Piece` is what that network lets
 * change; a network whose API has no edit does not implement it, so the type says so.
 */
export interface Editable<Piece> {
  edit(externalId: string, piece: Piece): Promise<void>;
}

/** A connector that can take down a piece it published (dev.to only unpublishes: it has no delete). */
export interface Deletable {
  delete(externalId: string): Promise<void>;
}
