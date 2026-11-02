import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Brand, LaunchConfig } from '@shipcast/schema';
import { buildPrompt, claimEvent, claimManual, draftLaunch, loadBrand, previousLaunchRef, previousOf, RELEASE_NOTES_MAX, type GitHubEvent, type Launch } from '../src/index.ts';
import { FakeGitHub, memoryRegistry, mockRunner, promptOf, scriptedModel, submitParts } from '../src/testing/index.ts';

/*
 * The kind of pack a release gets, from what exists besides the registry, and what a draft is
 * written from besides the code: the release's notes. Sluice v0.10.1 (2026-11-02) was drafted by the
 * Action as a first `launch` on an empty registry, with no notes in its prompt and no tone.
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://example.dev', github: 'me', languages: { blog: ['en', 'es'] } });
const LAUNCH_YML = 'enabled: true\nbrand: personal\n';
const REPO = 'me/sluice';
const LAUNCHES = 'me/launches';

function release(tag: string): GitHubEvent {
  return { id: '1', type: 'release', repo: REPO, tag, prerelease: false, url: `https://github.com/${REPO}/releases/tag/${tag}`, at: '2026-11-01T10:00:00Z' };
}

/** A project with launch.yml at `tag`, and whatever else the launches repo and the releases hold */
function github(tag: string, options: { files?: Record<string, string>; releases?: Array<{ tag: string; prerelease?: boolean; notes?: string }>; launchYml?: string } = {}): FakeGitHub {
  return new FakeGitHub({
    files: { [`${REPO}/.github/launch.yml@${tag}`]: options.launchYml ?? LAUNCH_YML, ...options.files },
    releases: { [REPO]: options.releases ?? [{ tag }] },
  });
}

const post = (repo: string, version?: string) =>
  `---\ntitle: "Sluice"\nlang: en\nrepo: "https://github.com/${repo}"\n${version ? `version: "${version}"\n` : ''}---\n\nBody.\n`;

async function kindOf(gh: FakeGitHub, tag: string, launchesRepo: string | undefined = LAUNCHES): Promise<string> {
  const outcome = await claimEvent(release(tag), { github: gh, registry: await memoryRegistry(), brand, launchesRepo });
  assert.equal(outcome.result, 'claimed');
  return 'launch' in outcome ? outcome.launch.kind : '';
}

test('a project whose article is already in the launches repo is not launched again: its post names the repo and the version', async () => {
  // The Sluice case: announced as an article (no launch folder), its post at v0.8.0, now v0.10.1
  const gh = github('v0.10.1', {
    files: {
      [`${LAUNCHES}/src/content/posts/en/sluice-shared-queue.md@HEAD`]: post(REPO, 'v0.8.0'),
      [`${LAUNCHES}/src/content/posts/es/sluice-una-cola.md@HEAD`]: post(REPO, 'v0.8.0'),
      [`${LAUNCHES}/src/content/posts/en/other-sluice-fork.md@HEAD`]: post('someone/sluice', 'v2.0.0'),
    },
  });
  assert.equal(await kindOf(gh, 'v0.10.1'), 'major', '0.8 → 0.10 is a breaking bump before 1.0');
});

test('an earlier launch folder in the launches repo makes the next release a later version', async () => {
  const gh = github('v0.10.1', { files: { [`${LAUNCHES}/launches/sluice/v0.10.0/bluesky.md@HEAD`]: 'post', [`${LAUNCHES}/launches/sluice/v0.9.0/pack.json@HEAD`]: '{}' } });
  assert.equal(await kindOf(gh, 'v0.10.1'), 'minor', 'compared with the latest one before it, v0.10.0');
});

test('a project with earlier releases is not being launched for the first time, announced or not', async () => {
  const gh = github('v0.10.1', { releases: [{ tag: 'v0.10.1' }, { tag: 'v0.11.0-rc.1', prerelease: true }, { tag: 'v0.10.0' }, { tag: 'v0.9.0' }] });
  assert.equal(await kindOf(gh, 'v0.10.1'), 'minor');
  // Without a launches repo to read, the releases still decide
  assert.equal(await kindOf(github('v1.0.0', { releases: [{ tag: 'v1.0.0' }, { tag: 'v0.9.0' }] }), 'v1.0.0', undefined), 'major');
});

test("the truly first release of a project is its launch", async () => {
  const gh = github('v0.1.0', { releases: [{ tag: 'v0.1.0' }, { tag: 'v0.2.0-beta.1', prerelease: true }], files: { [`${LAUNCHES}/src/content/posts/en/hello.md@HEAD`]: post('me/other', 'v1.0.0') } });
  assert.equal(await kindOf(gh, 'v0.1.0'), 'launch');
});

test("launch.yml's pack wins over every earlier launch, and nothing is looked up for it", async () => {
  const gh = github('v0.10.1', {
    launchYml: `${LAUNCH_YML}pack: launch\n`,
    releases: [{ tag: 'v0.10.1' }, { tag: 'v0.10.0' }],
    files: { [`${LAUNCHES}/launches/sluice/v0.10.0/pack.json@HEAD`]: '{}' },
  });
  assert.equal(await kindOf(gh, 'v0.10.1'), 'launch');
  assert.equal(gh.called('releases').length + gh.called('filesUnder').length, 0);

  const major = github('v0.10.1', { launchYml: `${LAUNCH_YML}pack: major\n` });
  assert.equal(await kindOf(major, 'v0.10.1'), 'major', 'a forced pack on a first release too');
});

test('the registry answers first; the launches repo and the releases are read only when it knows nothing', async () => {
  const registry = await memoryRegistry();
  const first = await registry.launches.claim({ repo: REPO, ref: 'v0.9.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  await registry.launches.setStatus(first.launch.id, 'published');
  const gh = github('v0.10.1', { releases: [{ tag: 'v0.10.1' }, { tag: 'v0.10.0' }] });
  assert.equal(await previousLaunchRef(REPO, 'v0.10.1', { github: gh, registry, launchesRepo: LAUNCHES }), 'v0.9.0');
  assert.equal(gh.calls.length, 0);
});

test('a post that names the project without a version still says it was announced', async () => {
  const gh = github('v1.0.0', { files: { [`${LAUNCHES}/src/content/posts/en/sluice-intro.md@HEAD`]: post(REPO) } });
  assert.equal(await kindOf(gh, 'v1.0.0'), 'minor', 'announced at an unknown version: the quiet pack');
});

test('a lookup that fails leaves the decision to the next source', async () => {
  const gh = github('v0.10.1', { releases: [{ tag: 'v0.10.1' }, { tag: 'v0.10.0' }] }).failOn('filesUnder', new Error('GitHub is down'));
  assert.equal(await kindOf(gh, 'v0.10.1'), 'minor');
});

test('a manual launch decides its pack the same way', async () => {
  const gh = github('v0.10.1', { files: { [`${LAUNCHES}/src/content/posts/en/sluice.md@HEAD`]: post(REPO, 'v0.8.0') } });
  const claim = await claimManual(REPO, 'v0.10.1', brand, { github: gh, registry: await memoryRegistry(), launchesRepo: LAUNCHES });
  assert.ok('claimed' in claim && claim.claimed);
  assert.equal(claim.launch.kind, 'major');
});

test('the previous ref is the highest version below the release, else any other', () => {
  assert.equal(previousOf('v0.10.1', ['v0.8.0', 'v0.10.0', 'v0.9.3', 'v0.10.1', 'v0.11.0']), 'v0.10.0');
  assert.equal(previousOf('v0.10.1', ['v0.10.1']), undefined);
  assert.equal(previousOf('nightly', ['v1.0.0']), 'v1.0.0');
  assert.equal(previousOf('v1.0.0', ['v2.0.0']), 'v2.0.0', 'only later ones: still announced before');
});

// The release notes

const BRAND_YML = 'id: personal\ndisplayName: Me\nsite: https://example.dev\ngithub: me\nlanguages:\n  blog: [en]\n';
const NOTES = '## The 0.10 line: a kernel ceiling on every gate job\n\nEvery gate job now runs under a kernel memory.max.';

const pack = {
  schemaVersion: 1,
  kind: 'minor',
  project: { name: 'sluice', repo: `https://github.com/${REPO}`, version: 'v0.10.1' },
  analysis: { summary: 's', implemented: ['x'], planned: [], documentedOnly: [], limitations: [] },
  article: { en: { slug: 'sluice-0-10', title: 'Sluice 0.10', description: 'd', markdown: 'b' } },
  bluesky: { lang: 'en', text: 'b' },
};

async function draft(options: { notes?: string; brandYml?: string } = {}) {
  const gh = new FakeGitHub({
    files: {
      [`${LAUNCHES}/brand.yml@HEAD`]: options.brandYml ?? BRAND_YML,
      [`${REPO}/.github/launch.yml@v0.10.1`]: 'enabled: true\nbrand: personal\npublishing:\n  devto: off\n  mastodon: off\n  githubDiscussions: off\n  instagram: off\n  reddit: off\n',
    },
    releases: { [REPO]: [{ tag: 'v0.10.1', ...(options.notes !== undefined && { notes: options.notes }) }] },
  });
  const registry = await memoryRegistry();
  const model = scriptedModel(submitParts(pack));
  const { launch } = await registry.launches.claim({ repo: REPO, ref: 'v0.10.1', trigger: 'release', kind: 'minor', brand: 'personal' });
  const result = await draftLaunch(launch, await loadBrand(gh, LAUNCHES), {
    github: gh,
    aiRunner: mockRunner(model),
    registry,
    launchesRepo: LAUNCHES,
    checkout: async () => ({ hostPath: '/h' }),
    now: () => new Date('2026-11-02T00:00:00Z'),
    fetch: (async () => new Response(null, { status: 404 })) as typeof fetch,
  });
  return { result, prompt: promptOf(model), body: gh.opened[0]?.body ?? '' };
}

test("the release's notes reach the pack prompt as the author's claims, and a later version leads with them", async () => {
  const { result, prompt } = await draft({ notes: NOTES });
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(prompt.includes('kernel ceiling on every gate job'), 'the notes are in the prompt');
  assert.ok(prompt.includes("The release notes of v0.10.1, as the author wrote them. They are the author's statement of what changed in this release and why, and what the pieces lead with"));
  assert.ok(prompt.includes("What they say the software does is a claim like the README's: check it against the code"), 'under the same truth rule as any claim');
  assert.ok(prompt.includes("What they tell of the author's own experience (the problem that led to the change, what they measured and where) is theirs to tell"), 'the lived story is usable as the author wrote it');
  assert.ok(prompt.includes('Lead with what changed in this release'), 'the minor pack leads with the change');
});

test('a release without notes sends the model to the history for what changed', async () => {
  const { prompt } = await draft();
  assert.ok(!prompt.includes('<release-notes>'));
  assert.ok(prompt.includes('v0.10.1 has no release notes: find what changed in this release from the code and its git history.'));
});

test('long release notes are cut at a line with a note saying so', () => {
  const launch = { id: 1, repo: REPO, ref: 'v1.0.0', kind: 'major', trigger: 'release' } as Launch;
  const line = `${'x'.repeat(99)}\n`;
  const { prompt } = buildPrompt(launch, LaunchConfig.parse({ enabled: true, brand: 'personal' }), brand, { releaseNotes: line.repeat(300) });
  const notes = prompt.slice(prompt.indexOf('<release-notes>'), prompt.indexOf('</release-notes>'));
  assert.ok(notes.length < RELEASE_NOTES_MAX + 200);
  assert.match(notes, /x\n\[… cut at 12000 characters; the rest is in the release on GitHub\]\n$/);
  assert.ok(!buildPrompt({ ...launch, ref: 'public:1' }, LaunchConfig.parse({ enabled: true, brand: 'personal' }), brand, { releaseNotes: 'n' }).prompt.includes('release notes'), 'a repo made public has none');
});

test('a brand with no tone gets a warning in the drafts pull request; one with a tone does not', async () => {
  const { body } = await draft({ notes: NOTES });
  assert.match(body, /^> \*\*brand\.yml has no tone:\*\* these drafts were written in a generic voice/m);
  const toned = await draft({ notes: NOTES, brandYml: `${BRAND_YML}tone: First person, direct.\n` });
  assert.ok(!toned.body.includes('has no tone'));
});
