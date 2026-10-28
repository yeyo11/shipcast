import type { Profile, ProfileEdit } from '@shipcast/connectors';
import { capabilityWithReview, PROFILE_CAPABILITIES, profileCapability, readProfileReview, type Registry } from '@shipcast/engine';
import type { ApiRoute } from './api.ts';
import { InvalidInput, object } from './input.ts';

/*
 * The account analysis routes of the REST API: an account's profile capability and latest review,
 * a review started as a job, and an edit made on the network. Kept apart from api.ts, which spreads
 * them into its routes and its OpenAPI document; only types come back from api.ts, so the two
 * modules never need each other at load time. See docs/decisions/account-analysis.md
 */

type JsonSchema = Record<string, unknown>;

/** What the routes run in the app's process; left out where only reading is wired (tests of other routes) */
export interface ProfileApi {
  review(accountId: number, request: ReviewInput): Promise<{ ok: true; job: string } | { ok: false; problem: string }>;
  edit(accountId: number, edit: ProfileEdit): Promise<Profile | undefined>;
}

export interface ReviewInput {
  pasted?: { displayName?: string; bio?: string; links?: string };
  language?: string;
}

const answer = (status: number, body: unknown) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const failure = (status: number, code: string, message: string) => answer(status, { error: { code, message } });

function optionalText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) throw new InvalidInput(`${name} is text of at most ${max} characters`);
  return value;
}

/** A review's body: what the owner pasted where the network cannot read the profile, and the language */
export function reviewInput(value: unknown): ReviewInput {
  const body = value === undefined ? {} : object(value, 'the body');
  const pastedBody = body.pasted === undefined ? undefined : object(body.pasted, 'pasted');
  const language = optionalText(body.language, 'language', 10);
  if (language !== undefined && !/^[a-z]{2}$/.test(language)) throw new InvalidInput('language is an ISO 639-1 code, such as en or es');
  const pasted = pastedBody && {
    ...(pastedBody.displayName !== undefined && { displayName: optionalText(pastedBody.displayName, 'pasted.displayName', 500) }),
    ...(pastedBody.bio !== undefined && { bio: optionalText(pastedBody.bio, 'pasted.bio', 5000) }),
    ...(pastedBody.links !== undefined && { links: optionalText(pastedBody.links, 'pasted.links', 5000) }),
  };
  return { ...(pasted && { pasted: pasted as ReviewInput['pasted'] }), ...(language && { language }) };
}

/** An edit's body: the name, the bio and the links, each left out to keep it */
export function profileEditInput(value: unknown): ProfileEdit {
  const body = object(value, 'the body');
  const unknown = Object.keys(body).filter((k) => !['displayName', 'bio', 'links'].includes(k));
  if (unknown.length > 0) throw new InvalidInput(`${unknown.join(', ')}: a profile edit takes displayName, bio and links`);
  const displayName = optionalText(body.displayName, 'displayName', 500);
  const bio = optionalText(body.bio, 'bio', 5000);
  let links: ProfileEdit['links'];
  if (body.links !== undefined) {
    if (!Array.isArray(body.links) || body.links.length > 20) throw new InvalidInput('links is a list of { name, value }');
    links = body.links.map((l, i) => {
      const link = object(l, `links[${i}]`);
      return { name: optionalText(link.name, `links[${i}].name`, 500) ?? '', value: optionalText(link.value, `links[${i}].value`, 2000) ?? '' };
    });
  }
  const edit: ProfileEdit = { ...(displayName !== undefined && { displayName }), ...(bio !== undefined && { bio }), ...(links && { links }) };
  if (Object.keys(edit).length === 0) throw new InvalidInput('send at least one of displayName, bio, links');
  return edit;
}

function accountId(value: string | undefined): number {
  const n = /^\d{1,10}$/.test(value ?? '') ? Number(value) : NaN;
  if (!Number.isInteger(n) || n <= 0) throw new InvalidInput('the account id must be a positive integer');
  return n;
}

async function readBody(request: Request, optional: boolean): Promise<unknown> {
  const text = await request.text();
  if (text === '' && optional) return undefined;
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new InvalidInput('send JSON, with content-type: application/json');
  if (text.length > 50_000) throw new InvalidInput('the body is too large');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InvalidInput('the body is not valid JSON');
  }
}

/** An account's capability and its latest review, as the app's page and the API show them */
export async function profileView(registry: Registry, id: number) {
  const account = await registry.accounts.account(id);
  if (!account) return undefined;
  const review = await readProfileReview(registry, id);
  const capability = profileCapability(account);
  return { capability: capability ? capabilityWithReview(capability, review) : null, review: review ?? null };
}


const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const unavailable = () => failure(409, 'refused', 'profile reviews and edits are not available in this process');

export const PROFILE_ROUTES: ApiRoute[] = [
  {
    method: 'GET',
    path: '/profile-capabilities',
    scope: 'read',
    operationId: 'listProfileCapabilities',
    summary: 'What each network lets Shipcast do with an account’s profile: read it, edit which fields, within which limits',
    response: {
      status: 200,
      description: 'The profile capability of every network that has a profile',
      schema: { type: 'object', required: ['capabilities'], properties: { capabilities: { type: 'object', additionalProperties: ref('ProfileCapability') } } },
    },
    async handle() {
      return answer(200, { capabilities: PROFILE_CAPABILITIES });
    },
  },
  {
    method: 'GET',
    path: '/accounts/{accountId}/profile-review',
    scope: 'read',
    operationId: 'getProfileReview',
    summary: 'An account’s profile capability, narrowed by its credential, and its latest AI review (null until one ran)',
    response: {
      status: 200,
      description: 'The capability and the review',
      schema: { type: 'object', required: ['capability', 'review'], properties: { capability: { oneOf: [ref('ProfileCapability'), { type: 'null' }] }, review: { oneOf: [ref('ProfileReview'), { type: 'null' }] } } },
    },
    async handle(deps, { params }) {
      const view = await profileView(deps.registry, accountId(params.accountId));
      return view ? answer(200, view) : failure(404, 'not_found', 'no such account');
    },
  },
  {
    method: 'POST',
    path: '/accounts/{accountId}/profile-review',
    scope: 'write',
    operationId: 'reviewProfile',
    summary: 'Review an account’s profile with the AI (the profile task): a job reads it and proposes each field’s new text; nothing changes on the network',
    body: {
      type: 'object',
      properties: {
        pasted: {
          type: 'object',
          description: 'The profile as it is, for a network whose API cannot read it (Instagram, Threads, LinkedIn, Reddit)',
          properties: { displayName: { type: 'string' }, bio: { type: 'string' }, links: { type: 'string', description: 'One per line, as `Label: value`' } },
        },
        language: { type: 'string', description: 'One of the brand’s languages; its first when left out' },
      },
    },
    response: { status: 202, description: 'Accepted: a job reviews the profile', schema: ref('Accepted') },
    async handle(deps, { params, request }) {
      const id = accountId(params.accountId);
      const input = reviewInput(await readBody(request, true));
      if (!deps.profiles) return unavailable();
      const started = await deps.profiles.review(id, input);
      if (started.ok) return answer(202, { job: started.job });
      return started.problem === 'no such account' ? failure(404, 'not_found', started.problem) : failure(409, 'refused', started.problem);
    },
  },
  {
    method: 'PATCH',
    path: '/accounts/{accountId}/profile',
    scope: 'write',
    operationId: 'editProfile',
    summary: 'Change an account’s profile on its network (Mastodon, Bluesky, a Telegram channel): only the fields sent, within the network’s limits',
    body: {
      type: 'object',
      minProperties: 1,
      properties: {
        displayName: { type: 'string' },
        bio: { type: 'string' },
        links: { type: 'array', items: { type: 'object', required: ['name', 'value'], properties: { name: { type: 'string' }, value: { type: 'string' } } }, description: 'The whole list (Mastodon’s fields)' },
      },
    },
    response: { status: 200, description: 'The profile as the network has it now, when it can be read', schema: { type: 'object', required: ['profile'], properties: { profile: { oneOf: [ref('Profile'), { type: 'null' }] } } } },
    async handle(deps, { params, request }) {
      const id = accountId(params.accountId);
      const edit = profileEditInput(await readBody(request, false));
      if (!deps.profiles) return unavailable();
      const profiles = deps.profiles;
      return answer(200, { profile: (await profiles.edit(id, edit)) ?? null });
    },
  },
];

const fieldEnum = { type: 'string', enum: ['displayName', 'bio', 'links', 'avatar'] };

/** The components the profile routes' responses name, merged into the OpenAPI document's */
export const PROFILE_SCHEMAS: Record<string, JsonSchema> = {
  ProfileCapability: {
    type: 'object',
    properties: {
      read: { type: 'boolean', description: 'Whether Shipcast reads the profile itself; without, the owner pastes it' },
      edit: { type: 'string', enum: ['yes', 'no', 'reconnect'], description: '`reconnect`: the network can, but this account’s credential was not granted it' },
      fields: { type: 'array', items: fieldEnum },
      editable: { type: 'array', items: fieldEnum },
      limits: { type: 'object', properties: { displayName: { type: 'integer' }, bio: { type: 'integer' }, graphemes: { type: 'boolean' }, links: { type: 'object' } } },
      note: { type: 'string' },
    },
  },
  Profile: {
    type: 'object',
    properties: {
      displayName: { type: 'string' },
      bio: { type: 'string' },
      links: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } } } },
      hasAvatar: { type: 'boolean' },
      hasBanner: { type: 'boolean' },
    },
  },
  ProfileReview: {
    type: 'object',
    properties: {
      accountId: { type: 'integer' },
      network: { type: 'string' },
      reviewedAt: { type: 'string', format: 'date-time' },
      language: { type: 'string' },
      summary: { type: 'string' },
      profile: ref('Profile'),
      proposals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            field: fieldEnum,
            current: { type: 'string' },
            proposed: { type: 'string', description: 'Links one per line as `Label: value`' },
            why: { type: 'string' },
            problem: { type: 'string', description: 'Why it cannot be applied as it is' },
            appliedAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  },
};
