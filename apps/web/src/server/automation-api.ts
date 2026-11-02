import { MIN_INTERVAL_SECONDS, type Automation, type AutomationMode, type Happened } from '@shipcast/runtime';
import { CHANNELS, MAX_TRIGGER_RULES, type TriggerRule } from '@shipcast/schema';
import type { ApiRoute } from './api.ts';
import { InvalidInput, object } from './input.ts';

/*
 * The automation routes of the REST API: how Shipcast hears of releases (polling, webhooks or off),
 * the trigger rules, and a round run now (the Automation page's server functions,
 * automation.functions.ts). The webhook secret is never served: it is made and shown in the app.
 *
 * Kept apart from api.ts, which spreads them into its routes and its OpenAPI document; only types come
 * back from api.ts, so the two modules never need each other at load time. A route and the server
 * function it mirrors call the same service. See docs/decisions/mcp-parity.md
 */

type JsonSchema = Record<string, unknown>;

/** What the Automation page and GET /automation show: the settings, the last round and delivery, the webhook without its secret, the rules */
export interface AutomationState extends Automation {
  running: boolean;
  lastRound: Happened | null;
  lastDelivery: Happened | null;
  webhookUrl: string;
  /** Whether a webhook secret is set; the secret itself never leaves the server */
  hasSecret: boolean;
  /** The GitHub App delivers for every repo it is installed on, signed with its own secret */
  appWebhooks: boolean;
  /** The rules in force */
  triggers: TriggerRule[];
}

/** A change of the settings: what is left out stays as it is */
export type AutomationChange = Partial<Automation>;

/**
 * What the routes run in the app's process, built per request by automationApi in automation.server.ts; left out
 * where it is not wired (the tests of other routes), so a route answers a refusal without it
 */
export interface AutomationApi {
  state(): Promise<AutomationState>;
  change(change: AutomationChange): Promise<Automation>;
  /** Replaces the rules as a whole; a rule that does not hold is a 400 */
  saveTriggers(rules: unknown[]): Promise<TriggerRule[]>;
  /** `job` is null when the queue moved the round already waiting without naming it */
  roundNow(): Promise<{ ok: true; job: string | null } | { ok: false; problem: string }>;
}

const answer = (status: number, body: unknown) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const failure = (status: number, code: string, message: string) => answer(status, { error: { code, message } });
const unavailable = () => failure(409, 'refused', 'automation is not available in this process');

const MODES: readonly AutomationMode[] = ['poll', 'webhook', 'off'];
// A week: a longer gap is automation off in all but name
const MAX_INTERVAL_SECONDS = 604_800;

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new InvalidInput('send JSON, with content-type: application/json');
  const text = await request.text();
  if (text.length > 100_000) throw new InvalidInput('the body is too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new InvalidInput('the body is not valid JSON');
  }
  return object(parsed, 'the body');
}

/** A settings change's body: the mode and the interval, at least one of them */
export function automationChange(body: Record<string, unknown>): AutomationChange {
  const unknown = Object.keys(body).filter((k) => k !== 'mode' && k !== 'intervalSeconds');
  if (unknown.length > 0) throw new InvalidInput(`${unknown.join(', ')}: the automation settings are mode and intervalSeconds`);
  const change: AutomationChange = {};
  if (body.mode !== undefined) {
    if (!MODES.includes(body.mode as AutomationMode)) throw new InvalidInput('mode is poll, webhook or off');
    change.mode = body.mode as AutomationMode;
  }
  if (body.intervalSeconds !== undefined) {
    const seconds = body.intervalSeconds;
    if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < MIN_INTERVAL_SECONDS || seconds > MAX_INTERVAL_SECONDS) {
      throw new InvalidInput(`intervalSeconds is a whole number of seconds from ${MIN_INTERVAL_SECONDS} to ${MAX_INTERVAL_SECONDS}`);
    }
    change.intervalSeconds = seconds;
  }
  if (Object.keys(change).length === 0) throw new InvalidInput('send at least one of mode, intervalSeconds');
  return change;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const settings = { type: 'object', required: ['mode', 'intervalSeconds'], properties: { mode: ref('AutomationMode'), intervalSeconds: { type: 'integer' } } };

export const AUTOMATION_ROUTES: ApiRoute[] = [
  {
    method: 'GET',
    path: '/automation',
    scope: 'read',
    operationId: 'getAutomation',
    summary: 'How Shipcast hears of releases: the mode, the interval between rounds, the last round and webhook delivery, whether a webhook secret is set (never the secret), and the trigger rules',
    response: { status: 200, description: 'The automation settings and state', schema: ref('AutomationState') },
    async handle(deps) {
      if (!deps.automation) return unavailable();
      return answer(200, await deps.automation.state());
    },
  },
  {
    method: 'PATCH',
    path: '/automation',
    scope: 'write',
    operationId: 'setAutomation',
    summary: 'Change the mode or the interval between rounds; the next round comes soon after, at the new cadence from then on (none while off)',
    body: {
      type: 'object',
      minProperties: 1,
      properties: {
        mode: ref('AutomationMode'),
        intervalSeconds: { type: 'integer', minimum: MIN_INTERVAL_SECONDS, maximum: MAX_INTERVAL_SECONDS, description: 'Seconds between rounds' },
      },
    },
    response: { status: 200, description: 'The settings as saved', schema: settings },
    async handle(deps, { request }) {
      const change = automationChange(await readBody(request));
      if (!deps.automation) return unavailable();
      return answer(200, await deps.automation.change(change));
    },
  },
  {
    method: 'PUT',
    path: '/automation/triggers',
    scope: 'write',
    operationId: 'setTriggers',
    summary: 'Replace the trigger rules as a whole: which GitHub events create a launch; an event takes the first enabled rule it matches, and an empty list means none does',
    body: { type: 'object', required: ['rules'], properties: { rules: { type: 'array', maxItems: MAX_TRIGGER_RULES, items: ref('TriggerRule') } } },
    response: { status: 200, description: 'The rules as saved', schema: { type: 'object', required: ['rules'], properties: { rules: { type: 'array', items: ref('TriggerRule') } } } },
    async handle(deps, { request }) {
      const body = await readBody(request);
      if (!Array.isArray(body.rules)) throw new InvalidInput('rules is the list of trigger rules');
      if (!deps.automation) return unavailable();
      return answer(200, { rules: await deps.automation.saveTriggers(body.rules as unknown[]) });
    },
  },
  {
    method: 'POST',
    path: '/automation/round',
    scope: 'write',
    operationId: 'runRound',
    summary: 'Run an automation round now, whatever the mode: it looks for releases and drafts them, queues the publishing of what is approved or due, and reads the numbers when due; the round already waiting is moved to now',
    response: {
      status: 202,
      description: 'Accepted: a job runs the round',
      schema: { type: 'object', required: ['job'], properties: { job: { type: ['string', 'null'], description: 'The round’s job; follow it at /jobs' } } },
    },
    async handle(deps) {
      if (!deps.automation) return unavailable();
      const started = await deps.automation.roundNow();
      return started.ok ? answer(202, { job: started.job }) : failure(409, 'refused', started.problem);
    },
  },
];

const happened = {
  oneOf: [
    {
      type: 'object',
      properties: { at: { type: 'string', format: 'date-time' }, summary: { type: 'string' }, lines: { type: 'array', items: { type: 'string' }, description: 'The last twenty things it did' } },
    },
    { type: 'null' },
  ],
};

/** The components the automation routes' responses name, merged into the OpenAPI document's */
export const AUTOMATION_SCHEMAS: Record<string, JsonSchema> = {
  AutomationMode: {
    type: 'string',
    enum: [...MODES],
    description: 'poll: rounds on a timer look for releases; webhook: GitHub tells Shipcast at once and the timer publishes and reads the numbers; off: nothing runs on its own',
  },
  AutomationState: {
    type: 'object',
    properties: {
      mode: ref('AutomationMode'),
      intervalSeconds: { type: 'integer' },
      running: { type: 'boolean', description: 'Whether a round is running now' },
      lastRound: happened,
      lastDelivery: happened,
      webhookUrl: { type: 'string', format: 'uri', description: 'Where GitHub sends its webhooks' },
      hasSecret: { type: 'boolean', description: 'Whether a webhook secret is set; the secret is never served' },
      appWebhooks: { type: 'boolean', description: 'Whether the GitHub App delivers, signed with its own secret' },
      triggers: { type: 'array', items: ref('TriggerRule'), description: 'The rules that decide which GitHub events create a launch' },
    },
  },
  TriggerRule: {
    type: 'object',
    required: ['id', 'event'],
    properties: {
      id: { type: 'string', pattern: '^[a-z0-9-]{1,40}$' },
      enabled: { type: 'boolean', default: true },
      event: { type: 'string', enum: ['release', 'public'], description: 'release: a release is published; public: a repo goes from private to public' },
      repos: { type: 'string', default: '*', description: '*, owner/* or owner/name' },
      prereleases: { type: 'boolean', default: false },
      channels: {
        oneOf: [{ type: 'array', items: { type: 'string', enum: [...CHANNELS] } }, { type: 'null' }],
        default: null,
        description: 'For a repo without launch.yml: null leaves it alone, a list launches it on those channels, each waiting for approval',
      },
    },
  },
};
