import type { LaunchStatus, Preflight } from '@shipcast/engine';
import type { ApiRoute } from './api.ts';
import { InvalidInput } from './input.ts';
import { isRepo } from './launches-search.ts';

/*
 * The repos routes of the REST API: the owner's repos and their releases to launch from, and the
 * pre-flight of one alone (the Launch page's server functions, launches.functions.ts).
 *
 * Kept apart from api.ts, which spreads them into its routes and its OpenAPI document; only types come
 * back from api.ts, so the two modules never need each other at load time. A route and the server
 * function it mirrors call the same service. See docs/decisions/mcp-parity.md
 */

type JsonSchema = Record<string, unknown>;

/** What the Launch page offers to launch from: the brand's GitHub owner and its repos */
export interface RepoChoices {
  owner: string;
  /** Newest push first; forks and archived repos left out */
  repos: Array<{ repo: string; description: string | null; pushedAt: string }>;
}

/** A published release, and the launch already made of it: a launch happens once */
export interface ReleaseView {
  tag: string;
  name: string;
  publishedAt: string;
  prerelease: boolean;
  launch: { id: number; status: LaunchStatus } | null;
}

/**
 * What the routes run in the app's process, built per request by reposApi in repos.server.ts; left out
 * where it is not wired (the tests of other routes), so a route answers a refusal without it
 */
export interface ReposApi {
  repos(): Promise<RepoChoices>;
  /** Newest first */
  releases(repo: string): Promise<ReleaseView[]>;
  /** The latest release's when `ref` is left out, as a launch takes it */
  check(repo: string, ref: string | undefined): Promise<Preflight>;
}

const answer = (status: number, body: unknown) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const failure = (status: number, code: string, message: string) => answer(status, { error: { code, message } });
const unavailable = () => failure(409, 'refused', 'repos and releases are not available in this process');
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

function repoParam(url: URL): string {
  const repo = url.searchParams.get('repo');
  if (repo === null || !isRepo(repo)) throw new InvalidInput('repo is owner/name, as GET /repos lists them');
  return repo;
}

function refParam(url: URL): string | undefined {
  const value = url.searchParams.get('ref');
  if (value === null || value === '') return undefined;
  if (value.length > 140) throw new InvalidInput('ref is a release tag of at most 140 characters');
  return value;
}

const REPO_QUERY = { name: 'repo', description: 'Required: the GitHub repo, owner/name', schema: { type: 'string', pattern: '^[\\w.-]+/[\\w.-]+$' } };

export const REPOS_ROUTES: ApiRoute[] = [
  {
    method: 'GET',
    path: '/repos',
    scope: 'read',
    operationId: 'listRepos',
    summary: 'The brand owner’s GitHub repos to launch from, newest push first (forks and archived ones left out). Cached for a few minutes: a repo made a moment ago may be missing',
    response: { status: 200, description: 'The owner, the repos and the ways to launch', schema: ref('RepoChoices') },
    async handle(deps) {
      if (!deps.repos) return unavailable();
      return answer(200, await deps.repos.repos());
    },
  },
  {
    method: 'GET',
    path: '/repos/releases',
    scope: 'read',
    operationId: 'listReleases',
    summary: 'A repo’s published releases, newest first, each with the launch already made of it (null when none): a release is launched only once',
    query: [REPO_QUERY],
    response: {
      status: 200,
      description: 'The repo and its releases',
      schema: { type: 'object', required: ['repo', 'releases'], properties: { repo: { type: 'string' }, releases: { type: 'array', items: ref('Release') } } },
    },
    async handle(deps, { url }) {
      const repo = repoParam(url);
      if (!deps.repos) return unavailable();
      return answer(200, { repo, releases: await deps.repos.releases(repo) });
    },
  },
  {
    method: 'GET',
    path: '/repos/preflight',
    scope: 'read',
    operationId: 'checkRepo',
    summary: 'The pre-flight of a repo at a release, without launching: the release, launch.yml, the license, the README and the demo, each with a sentence to act on',
    query: [REPO_QUERY, { name: 'ref', description: 'A release tag; the latest release when left out, as a launch takes it', schema: { type: 'string', maxLength: 140 } }],
    response: { status: 200, description: 'Whether the repo can launch, and each check', schema: ref('Preflight') },
    async handle(deps, { url }) {
      const repo = repoParam(url);
      const tag = refParam(url);
      if (!deps.repos) return unavailable();
      return answer(200, await deps.repos.check(repo, tag));
    },
  },
];

/** The components the repos routes' responses name, merged into the OpenAPI document's */
export const REPOS_SCHEMAS: Record<string, JsonSchema> = {
  RepoChoices: {
    type: 'object',
    required: ['owner', 'repos'],
    properties: {
      owner: { type: 'string', description: 'The brand’s GitHub owner, whose repos these are' },
      repos: {
        type: 'array',
        items: {
          type: 'object',
          required: ['repo', 'description', 'pushedAt'],
          properties: { repo: { type: 'string', description: 'owner/name' }, description: { type: ['string', 'null'] }, pushedAt: { type: 'string', format: 'date-time' } },
        },
      },
    },
  },
  Release: {
    type: 'object',
    required: ['tag', 'name', 'publishedAt', 'prerelease', 'launch'],
    properties: {
      tag: { type: 'string' },
      name: { type: 'string' },
      publishedAt: { type: 'string', format: 'date-time' },
      prerelease: { type: 'boolean' },
      launch: {
        oneOf: [{ type: 'object', required: ['id', 'status'], properties: { id: { type: 'integer' }, status: { type: 'string' } } }, { type: 'null' }],
        description: 'The launch already made of this release, which launching it again would be refused for',
      },
    },
  },
  Preflight: {
    type: 'object',
    required: ['repo', 'ok', 'checks'],
    properties: {
      repo: { type: 'string' },
      ref: { type: 'string', description: 'The tag asked for; absent when the latest release was checked' },
      ok: { type: 'boolean', description: 'Whether every required check passes: the repo can launch' },
      checks: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'ok', 'required', 'detail'],
          properties: {
            id: { type: 'string', enum: ['release', 'launchYml', 'license', 'readme', 'demo'] },
            ok: { type: 'boolean' },
            required: { type: 'boolean', description: 'A failing required check blocks the launch' },
            detail: { type: 'string', description: 'One sentence a person can act on' },
          },
        },
      },
    },
  },
};
