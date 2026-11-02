import type { Account } from '@shipcast/engine';
import type { ApiRoute, WorkAnswer } from './api.ts';
import { accountService } from './app-services.ts';
import { InvalidInput, object } from './input.ts';
import { accountId, answer, failure, readBody } from './profile-api.ts';

/*
 * The account routes of the REST API beyond the list: an account checked again, synced now, renamed
 * or made the primary one (the Channels page's server functions, channels.functions.ts). Connecting
 * and disconnecting stay the app's: a credential never comes through the API. Profiles are in
 * profile-api.ts, growth in stats-api.ts.
 *
 * Kept apart from api.ts, which spreads them into its routes and its OpenAPI document; only types come
 * back from api.ts, so the two modules never need each other at load time. A route and the server
 * function it mirrors call the same service. See docs/decisions/mcp-parity.md
 */

type JsonSchema = Record<string, unknown>;

/**
 * What the routes run in the app's process, built per request by accountsApi in accounts.server.ts;
 * left out where it is not wired (the tests of other routes), so a route answers a refusal without it
 */
export interface AccountsApi {
  /** The credential checked again and the answer recorded; undefined when there is no such account */
  check(accountId: number): Promise<Account | undefined>;
  /** The account's sync (its check, then today's numbers) queued as a job; undefined when there is no such account */
  sync(accountId: number): Promise<WorkAnswer | undefined>;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const accountAnswer = { type: 'object', required: ['account'], properties: { account: ref('Account') } };
const unavailable = () => failure(409, 'refused', 'checking and syncing accounts is not available in this process');
const missing = () => failure(404, 'not_found', 'no such account');

/** A rename's body: the new label, which cannot be blank since it tells the account apart from its network's others */
export function labelInput(value: unknown): string {
  const label = object(value, 'the body').label;
  if (typeof label !== 'string' || label.length > 200 || !label.trim()) throw new InvalidInput('label is text of 1 to 200 characters');
  return label;
}

export const ACCOUNTS_ROUTES: ApiRoute[] = [
  {
    method: 'POST',
    path: '/accounts/{accountId}/check',
    scope: 'write',
    operationId: 'checkAccount',
    summary: 'Check an account’s credential again on its network and record the answer: its status, its identity or the problem',
    response: { status: 200, description: 'The account with the new check', schema: accountAnswer },
    async handle(deps, { params }) {
      const id = accountId(params.accountId);
      if (!deps.accounts) return unavailable();
      const account = await deps.accounts.check(id);
      return account ? answer(200, { account }) : missing();
    },
  },
  {
    method: 'POST',
    path: '/accounts/{accountId}/sync',
    scope: 'write',
    operationId: 'syncAccount',
    summary: 'Sync an account now: a job checks it again and records today’s followers, following and posts; a sync already queued for it is the one answered',
    response: { status: 202, description: 'Accepted: a job syncs the account', schema: ref('Accepted') },
    async handle(deps, { params }) {
      const id = accountId(params.accountId);
      if (!deps.accounts) return unavailable();
      const started = await deps.accounts.sync(id);
      if (!started) return missing();
      return started.ok ? answer(202, { job: started.job }) : failure(409, 'refused', started.problem);
    },
  },
  {
    method: 'PATCH',
    path: '/accounts/{accountId}',
    scope: 'write',
    operationId: 'renameAccount',
    summary: 'Rename an account: the label Shipcast shows for it; nothing changes on the network',
    body: { type: 'object', required: ['label'], properties: { label: { type: 'string', minLength: 1, maxLength: 200, description: 'Trimmed; it cannot be blank' } } },
    response: { status: 200, description: 'The account renamed', schema: accountAnswer },
    async handle(deps, { params, request }) {
      const id = accountId(params.accountId);
      const label = labelInput(await readBody(request, false));
      const accounts = accountService(deps);
      if (!(await accounts.get(id))) return missing();
      await accounts.rename(id, label);
      const account = await accounts.get(id);
      return account ? answer(200, { account }) : missing();
    },
  },
  {
    method: 'POST',
    path: '/accounts/{accountId}/primary',
    scope: 'write',
    operationId: 'makePrimaryAccount',
    summary: 'Make an account the one its brand publishes with on its network; the account that was primary stays connected',
    response: { status: 200, description: 'The account, now primary', schema: accountAnswer },
    async handle(deps, { params }) {
      const id = accountId(params.accountId);
      const accounts = accountService(deps);
      if (!(await accounts.get(id))) return missing();
      await accounts.makePrimary(id);
      const account = await accounts.get(id);
      return account ? answer(200, { account }) : missing();
    },
  },
];

export const ACCOUNTS_SCHEMAS: Record<string, JsonSchema> = {};
