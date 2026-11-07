import { setTimeout as sleep } from 'node:timers/promises';
import { ConnectorError, HttpClient } from '@shipcast/connectors';
import { AiError } from '@shipcast/schema';
import { z } from 'zod';
import { errorBodyOf, fromHttpFailure, type AiErrorTable } from '../../errors.ts';
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
  /** How long a workspace whose download timed out or failed waits before its one more try; 20 s by default (the tests' is short) */
  retryWaitMs?: number;
}

const DEFAULT_PROVIDER = { id: 'claudio', name: 'Claudio', errors: CLAUDIO_ERRORS };
/** Claudio gives a download 60 s; each try's answer is waited a little longer than that */
const CREATE_TIMEOUT_MS = 90_000;
/**
 * A freshly published tag's codeload archive may take a while to be ready: a download that timed
 * out (408) or failed (502) is tried once more after this wait. Claudio leaves nothing on disk after
 * a refusal, so the second POST never leaves a workspace behind. A create takes at most two tries
 * and the wait: 2 × 90 s + 20 s, under the run's own deadline (its signal stops either).
 */
const CREATE_RETRY_WAIT_MS = 20_000;
const CREATE_RETRIED = new Set(['workspace-timeout', 'workspace-download-failed']);

/** Claudio's workspace API over the connectors' HttpClient (timeouts, counted calls) */
export class ClaudioWorkspaces {
  readonly #http: HttpClient;
  readonly #token: string;
  readonly #provider: NonNullable<ClaudioClientSettings['provider']>;
  readonly #retryWaitMs: number;

  constructor(settings: ClaudioClientSettings) {
    this.#http = new HttpClient({ network: 'Claudio', baseUrl: `${settings.baseURL.replace(/\/+$/, '')}/`, ...(settings.fetch && { fetch: settings.fetch }) });
    this.#token = settings.token;
    this.#provider = settings.provider ?? DEFAULT_PROVIDER;
    this.#retryWaitMs = settings.retryWaitMs ?? CREATE_RETRY_WAIT_MS;
  }

  /**
   * A workspace from a URL Claudio downloads (https, an allowed host) or from a gzip tarball sent in
   * the body, which must hold no `.git` path. Claudio may download api.github.com's tarball URL too,
   * but a private repo's needs a GitHub token there, which never goes to Claudio: the runner gives it
   * codeload's URL, resolved on Shipcast's side. A download that timed out or failed is tried once
   * more after a wait (CREATE_RETRY_WAIT_MS); any other refusal fails the run at once.
   */
  async create(source: WorkspaceSource, signal?: AbortSignal): Promise<ClaudioWorkspace> {
    const body = 'url' in source ? { body: JSON.stringify({ url: source.url }), type: 'application/json' } : { body: source.archive, type: 'application/gzip' };
    const init = {
      method: 'POST',
      headers: { 'content-type': body.type },
      body: body.body,
      timeoutMs: CREATE_TIMEOUT_MS,
      // Not the HttpClient's blind retry: a POST answered late could leave a second workspace behind,
      // and nothing retries the run either (a draft job has no retries). Only Claudio's own "the
      // download timed out or failed" answers are tried again, once, below.
      retry: false,
      ...(signal && { signal }),
    } as const;
    let response = await this.#request('api/workspaces', init);
    if (!response.ok) {
      const refusal = await this.#refusal(response);
      if (!CREATE_RETRIED.has(refusal.code ?? '')) throw refusal.error;
      await sleep(this.#retryWaitMs, undefined, signal && { signal });
      response = await this.#request('api/workspaces', init);
      if (!response.ok) throw (await this.#refusal(response)).error;
    }
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
    const response = await this.#request(path, init);
    if (response.ok || alsoFine.includes(response.status)) return response;
    throw (await this.#refusal(response)).error;
  }

  /** Claudio's answer, whatever its status; only a Claudio that cannot be reached throws */
  async #request(path: string, init: Parameters<HttpClient['request']>[1] & {}): Promise<Response> {
    try {
      return await this.#http.request(path, { ...init, headers: { ...init.headers, authorization: `Bearer ${this.#token}` } });
    } catch (error) {
      if (error instanceof ConnectorError) throw new AiError('ai_unavailable', `the ${this.#provider.name} could not be reached: ${error.message}`, { provider: this.#provider.id, cause: error });
      throw error;
    }
  }

  /** A refusal as the AiError it fails with, and Claudio's code for it */
  async #refusal(response: Response): Promise<{ error: AiError; code: string | undefined }> {
    const text = await response.text().catch(() => '');
    const error = fromHttpFailure({ status: response.status, body: text, headers: Object.fromEntries(response.headers) }, { provider: this.#provider, secrets: [this.#token] });
    return { error, code: errorBodyOf(text).code };
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
