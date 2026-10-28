import type { BlogRepo } from '@shipcast/engine';
import { withGitHubFixtures, type PreviewFixtures } from '@shipcast/runtime';

/*
 * A preview copy that cannot reach a real network (SHIPCAST_PREVIEW_FAKE_NETWORKS=1, with
 * SHIPCAST_APP_TLS=off on the owner's machine, or =proxy on a server with its own `…_preview`
 * database: packages/runtime/src/preview/guard.ts). Every connector that would change something on a
 * network is swapped for a fake that answers success and writes what it was sent to the preview's
 * ledger (packages/runtime/src/preview/world.ts), and the GitHub client's writes are dry runs
 * (`previewGitHubFetch`), so the owner can try Edit, Delete, Schedule or the onboarding's Commit
 * brand.yml on a copy of his own data without touching one real post or repo. Drafting, draft edits
 * and approving are refused outright on top of that: they would spend an AI run, or act on a real
 * pull request the dry run cannot pretend to change. Reading stays real, except the files the
 * preview's fixtures hold (launches that exist only in the preview).
 */

export { fakeNetworks } from '@shipcast/runtime';

/** What a preview refuses to do, since it would write to the real launches repo or a real pull request */
export const PREVIEW_REFUSAL = 'This is a preview with fake networks: it does not write to GitHub (no drafting, no draft edits, no approving)';

const say = (line: string) => console.log(`[preview, fake network] ${line}`);

/** The blog's repo, faked: an article that is always there, and commits that go nowhere */
export const fakeBlogRepo: BlogRepo = {
  fileAt: async (_repo, path) => `---\ntitle: "A preview article"\n---\n\nThe body of ${path}.\n`,
  commitToBranch: async (_repo, _branch, message) => {
    say(`would commit to the launches repo: ${message}`);
    return { sha: 'preview' };
  },
  filesUnder: async () => [],
};

let fakeShas = 0;
/** A sha of the right shape that names no real object: a counter, so each fake commit differs */
const fakeSha = () => (++fakeShas).toString(16).padStart(40, '0');

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function bodyOf(init: RequestInit | undefined): Promise<Record<string, unknown>> {
  if (typeof init?.body !== 'string') return {};
  try {
    const parsed = JSON.parse(init.body) as unknown;
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * What GitHub would answer to a write on a repo, faked: enough of each answer's shape for the REST
 * client to carry on (a blob, tree or commit has a sha, a new branch a ref, a pull request a number
 * and an address, a merge its commit) so the work that wrote it ends as it would, and nothing left
 * the machine. The pull request is number 0, which GitHub never gives, so it cannot pass for a real one.
 */
export async function dryRunGitHubWrite(method: string, url: URL, init: RequestInit | undefined): Promise<Response> {
  const path = url.pathname;
  const body = await bodyOf(init);
  const repo = /^\/repos\/([^/]+\/[^/]+)\//.exec(path)?.[1] ?? 'unknown/unknown';
  const what = typeof body.message === 'string' ? `: ${body.message}` : typeof body.title === 'string' ? `: ${body.title}` : '';
  say(`would ${method} ${path} on GitHub${what}`);
  if (method === 'DELETE') return new Response(null, { status: 204 });
  if (method === 'POST' && /\/git\/(blobs|trees)$/.test(path)) return json(201, { sha: fakeSha() });
  if (method === 'POST' && path.endsWith('/git/commits')) return json(201, { sha: fakeSha(), tree: { sha: typeof body.tree === 'string' ? body.tree : fakeSha() }, message: body.message });
  if (method === 'POST' && path.endsWith('/git/refs')) return json(201, { ref: body.ref, object: { sha: body.sha, type: 'commit' } });
  if (method === 'PATCH' && path.includes('/git/refs/')) return json(200, { ref: path.slice(path.indexOf('/git/') + 5), object: { sha: body.sha, type: 'commit' } });
  if (method === 'POST' && path.endsWith('/pulls')) {
    return json(201, { number: 0, html_url: `https://github.com/${repo}/pull/0`, state: 'open', title: body.title, head: { ref: body.head } });
  }
  if (method === 'PUT' && /\/pulls\/\d+\/merge$/.test(path)) return json(200, { sha: fakeSha(), merged: true, message: 'Pull Request successfully merged (preview: not really)' });
  if (method === 'PUT' && path.includes('/contents/')) {
    return json(201, { content: { path: path.slice(path.indexOf('/contents/') + 10), sha: fakeSha() }, commit: { sha: fakeSha(), message: body.message } });
  }
  return json(200, {});
}

/**
 * The GitHub REST client's fetch on a preview: reading goes to GitHub as it is (the drafts, the
 * releases, the launches repo), and every write to a repo (a drafts pull request, a commit of an
 * article or of brand.yml, a merge) is logged and answered by `dryRunGitHubWrite`, so a preview can
 * walk through the onboarding or a round without one commit on the owner's repos.
 */
export function previewGitHubFetch(real: typeof fetch = fetch, fixtures?: PreviewFixtures): typeof fetch {
  const reads = withGitHubFixtures(fixtures, real);
  return async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method === 'GET' || method === 'HEAD') return reads(input, init);
    return dryRunGitHubWrite(method, new URL(input instanceof Request ? input.url : String(input)), init);
  };
}
