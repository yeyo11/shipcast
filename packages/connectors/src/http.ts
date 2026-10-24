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
