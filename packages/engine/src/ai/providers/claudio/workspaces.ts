import { ConnectorError, HttpClient } from '@shipcast/connectors';
import { AiError } from '@shipcast/schema';
import { z } from 'zod';
import { fromHttpFailure, type AiErrorTable } from '../../errors.ts';
import type { AiReadiness, WorkspaceSource } from '../definition.ts';
import { CLAUDIO_ERRORS } from './errors.ts';

/*
 * Claudio's workspaces: a repository Claudio downloads itself (a codeload URL) or is sent (a gzip
 * tarball), unpacked read-only for Claude Code to work in, and deleted when the run is over (or
 * after 2 h without use). Nothing is shared between the two machines but this API: no folder, no
 * token of GitHub's, only Claudio's own.
 */

/** A workspace as Claudio created it */
export const ClaudioWorkspace = z.object({
  /** All a chat names it by (X-Claudio-Workspace): where it lies on Claudio's side is Claudio's business */
  id: z.string().min(1),
  bytes: z.number(),
  files: z.number(),
  expiresAt: z.string(),
});
export type ClaudioWorkspace = z.infer<typeof ClaudioWorkspace>;

export interface ClaudioClientSettings {
  /** Claudio's address, without `/api` */
  baseURL: string;
  token: string;
  fetch?: typeof fetch;
  /** Whose failure an error names; Claudio's provider by default */
  provider?: { id: string; name: string; errors?: AiErrorTable };
}

const DEFAULT_PROVIDER = { id: 'claudio', name: 'Claudio', errors: CLAUDIO_ERRORS };
/** Claudio gives a download 60 s; the answer is waited a little longer than that */
const CREATE_TIMEOUT_MS = 90_000;

/** Claudio's workspace API over the connectors' HttpClient (timeouts, counted calls) */
export class ClaudioWorkspaces {
  readonly #http: HttpClient;
  readonly #token: string;
  readonly #provider: NonNullable<ClaudioClientSettings['provider']>;

  constructor(settings: ClaudioClientSettings) {
    this.#http = new HttpClient({ network: 'Claudio', baseUrl: `${settings.baseURL.replace(/\/+$/, '')}/`, ...(settings.fetch && { fetch: settings.fetch }) });
    this.#token = settings.token;
    this.#provider = settings.provider ?? DEFAULT_PROVIDER;
  }

  /**
   * A workspace from a URL Claudio downloads (https, an allowed host) or from a gzip tarball sent in
   * the body, which must hold no `.git` path. Claudio may download api.github.com's tarball URL too,
   * but a private repo's needs a GitHub token there, which never goes to Claudio: the runner gives it
   * codeload's URL, resolved on Shipcast's side.
   */
  async create(source: WorkspaceSource, signal?: AbortSignal): Promise<ClaudioWorkspace> {
    const body = 'url' in source ? { body: JSON.stringify({ url: source.url }), type: 'application/json' } : { body: source.archive, type: 'application/gzip' };
    const response = await this.#call('api/workspaces', {
      method: 'POST',
      headers: { 'content-type': body.type },
      body: body.body,
      timeoutMs: CREATE_TIMEOUT_MS,
      // A retried POST could leave a second workspace behind; the job queue retries the whole run
      retry: false,
      ...(signal && { signal }),
    });
    const parsed = ClaudioWorkspace.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new AiError('ai_unavailable', `the ${this.#provider.name} answered a workspace that is not one`, { provider: this.#provider.id });
    return parsed.data;
  }

  /** Deletes a workspace, stopping any chat in it; one already gone is as good as deleted */
  async delete(id: string): Promise<void> {
    const response = await this.#call(`api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' }, [404]);
    response.body?.cancel().catch(() => undefined);
  }

  async #call(path: string, init: Parameters<HttpClient['request']>[1] & {}, alsoFine: readonly number[] = []): Promise<Response> {
    let response: Response;
    try {
      response = await this.#http.request(path, { ...init, headers: { ...init.headers, authorization: `Bearer ${this.#token}` } });
    } catch (error) {
      if (error instanceof ConnectorError) throw new AiError('ai_unavailable', `the ${this.#provider.name} could not be reached: ${error.message}`, { provider: this.#provider.id, cause: error });
      throw error;
    }
    if (response.ok || alsoFine.includes(response.status)) return response;
    const text = await response.text().catch(() => '');
    throw fromHttpFailure({ status: response.status, body: text, headers: Object.fromEntries(response.headers) }, { provider: this.#provider, secrets: [this.#token] });
  }
}

const ReadyAnswer = z.object({ ready: z.boolean().optional(), reason: z.string().optional() });

/**
 * Whether Claudio can run Claude Code now: `/api/ready` (no token) answers 200, or 503 with why not
 * (`cli-missing`, `signed-out`, `sign-in-expired`, `starting`). What onboarding and the AI settings
 * say when Claude is not signed in; a Claudio that does not answer is `unreachable`.
 */
export async function claudioReady(settings: Omit<ClaudioClientSettings, 'token'>): Promise<AiReadiness> {
  const provider = settings.provider ?? DEFAULT_PROVIDER;
  const http = new HttpClient({ network: 'Claudio', baseUrl: `${settings.baseURL.replace(/\/+$/, '')}/`, timeoutMs: 10_000, retry: { attempts: 1 }, ...(settings.fetch && { fetch: settings.fetch }) });
  let response: Response;
  try {
    response = await http.request('api/ready');
  } catch (error) {
    if (!(error instanceof ConnectorError)) throw error;
    return { ready: false, reason: 'unreachable', message: `the ${provider.name} could not be reached` };
  }
  if (response.ok) {
    response.body?.cancel().catch(() => undefined);
    return { ready: true };
  }
  const answer = ReadyAnswer.safeParse(await response.json().catch(() => undefined));
  const reason = (answer.success && answer.data.reason) || `http-${response.status}`;
  const known = provider.errors?.[reason];
  return { ready: false, reason, message: known ? `the ${provider.name} ${known.message}` : `the ${provider.name} is not ready (${response.status})` };
}
