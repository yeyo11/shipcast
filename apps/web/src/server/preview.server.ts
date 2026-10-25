import type { BlogRepo, EditDeps, Editors, Publishers } from '@shipcast/engine';
import type { Services } from '@shipcast/runtime';

/*
 * A preview copy that cannot reach a real network. With SHIPCAST_PREVIEW_FAKE_NETWORKS=1 on a copy
 * served over plain HTTP (SHIPCAST_APP_TLS=off, which production never is), every connector that
 * would change something on a network is swapped for an in-memory fake that answers success, and
 * whatever would write to GitHub is refused, so the owner can try Edit, Delete and Schedule on a
 * copy of his own data without touching one real post. Reading stays real: a page still shows the
 * drafts and the numbers as they are.
 */

/** Whether this process is a preview with fake networks; the TLS condition keeps the switch from ever working in production */
export function fakeNetworks(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SHIPCAST_PREVIEW_FAKE_NETWORKS === '1' && env.SHIPCAST_APP_TLS === 'off';
}

/** What a preview refuses to do, since it would write to the real launches repo or a real pull request */
export const PREVIEW_REFUSAL = 'This is a preview with fake networks: it does not write to GitHub (no drafting, no draft edits, no approving)';

const say = (line: string) => console.log(`[preview, fake network] ${line}`);

const fakeEditor = (channel: string) => ({
  edit: async (id: string, input: unknown) => say(`would edit ${channel} ${id}: ${JSON.stringify(input, (k, v: unknown) => (k === 'bytes' ? '<bytes>' : v))}`),
  delete: async (id: string) => say(`would delete ${channel} ${id}`),
});

/** Every channel's editor, answering success, whatever account a piece went out with */
export const fakeEditors: EditDeps['editors'] = async () =>
  ({
    mastodon: fakeEditor('mastodon'),
    telegram: fakeEditor('telegram'),
    discord: fakeEditor('discord'),
    devto: fakeEditor('devto'),
    hashnode: fakeEditor('hashnode'),
    bluesky: { delete: fakeEditor('bluesky').delete },
  }) satisfies Editors;

/** The blog's repo, faked: an article that is always there, and commits that go nowhere */
export const fakeBlogRepo: BlogRepo = {
  fileAt: async (_repo, path) => `---\ntitle: "A preview article"\n---\n\nThe body of ${path}.\n`,
  commitToBranch: async (_repo, _branch, message) => {
    say(`would commit to the launches repo: ${message}`);
    return { sha: 'preview' };
  },
  filesUnder: async () => [],
};

const published = (channel: string) => async () => {
  const externalId = `preview-${channel}-${Date.now()}`;
  say(`would publish on ${channel}`);
  return { externalId, url: `https://example.invalid/${externalId}` };
};

/** Publishers that answer success; a scheduled piece that comes due in the preview goes nowhere */
export function fakePublishers(): Publishers {
  return {
    devto: { publish: published('devto') },
    hashnode: { publish: published('hashnode') },
    bluesky: { publish: published('bluesky') },
    mastodon: { publish: published('mastodon') },
    instagram: { publish: published('instagram'), publishStory: published('instagram story'), comment: async () => ({ id: 'preview' }) },
    newsletter: { subscribers: async () => 0, send: published('newsletter') },
    telegram: { publish: published('telegram') },
    discord: { publish: published('discord') },
  };
}

/**
 * The safety net under everything else a preview runs (account syncs, the comment assistant's
 * replies): reading goes through, and any request that would change something is answered with an
 * empty success instead of leaving the machine. A connector that needs a real answer then fails,
 * which is the safe way round.
 */
export const previewFetch: typeof fetch = async (input, init) => {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method === 'GET' || method === 'HEAD') return fetch(input, init);
  const url = input instanceof Request ? input.url : String(input);
  say(`would ${method} ${new URL(url).origin}${new URL(url).pathname}`);
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};

/** The real services with their writing parts replaced: fake publishers, no notifier, no Search Console ping */
export function previewServices(real: Services): Services {
  return { ...real, publishers: fakePublishers(), notifier: undefined, sources: { ...real.sources, search: undefined } };
}
