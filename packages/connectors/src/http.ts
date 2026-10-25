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

/** Whether a credential works, in words a person can act on: what the Channels page shows. */
export type Check = { ok: true; account: string } | { ok: false; problem: string };

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
