import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Brand } from '@shipcast/schema';
import { detect, Registry, type EventsPage, type GitHubEvent, type GitHubSource } from '../src/index.ts';

const brand = Brand.parse({ id: 'personal', displayName: 'Me', github: 'yeyo11' });

const VALID = 'enabled: true\nbrand: personal\n';

function release(id: string, repo: string, tag: string, prerelease = false): GitHubEvent {
  return { id, type: 'release', repo, tag, prerelease, url: `https://github.com/${repo}/releases/tag/${tag}`, at: '2026-10-24T10:00:00Z' };
}

/** A GitHub with fixed events and files; records what it was asked. */
class FakeGitHub implements GitHubSource {
  calls: string[] = [];
  pages: EventsPage[];
  files: Record<string, string>;
  constructor(pages: EventsPage[], files: Record<string, string> = {}) {
    this.pages = pages;
    this.files = files;
  }
  async userEvents(owner: string, etag?: string): Promise<EventsPage> {
    this.calls.push(`events ${owner} ${etag ?? '-'}`);
    return this.pages.shift() ?? { notModified: true };
  }
  async fileAt(repo: string, path: string, ref: string): Promise<string | undefined> {
    this.calls.push(`file ${repo} ${path} ${ref}`);
    return this.files[`${repo}@${ref}`];
  }
}

test('a published release of an enabled repo is claimed, with the pack inferred from the version', async () => {
  const registry = new Registry(':memory:');
  const github = new FakeGitHub(
    [{ notModified: false, etag: 'W/"1"', events: [release('100', 'yeyo11/claudio', 'v0.9.0')] }],
    { 'yeyo11/claudio@v0.9.0': VALID },
  );
  const [outcome] = await detect({ github, registry, brand });
  assert.equal(outcome?.result, 'claimed');
  assert.ok(outcome && 'launch' in outcome);
  assert.equal(outcome.launch.kind, 'launch', 'the first launch of a project');
  assert.equal(outcome.launch.trigger, 'release');
  assert.ok(github.calls.includes('file yeyo11/claudio .github/launch.yml v0.9.0'), 'launch.yml is read at the tag');
});

test('the next major after a published launch is a major pack', async () => {
  const registry = new Registry(':memory:');
  const first = registry.claim({ repo: 'yeyo11/claudio', ref: 'v0.8.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  registry.setStatus(first.launch.id, 'published');
  const github = new FakeGitHub(
    [{ notModified: false, etag: 'W/"1"', events: [release('100', 'yeyo11/claudio', 'v0.9.0')] }],
    { 'yeyo11/claudio@v0.9.0': VALID },
  );
  const [outcome] = await detect({ github, registry, brand });
  assert.ok(outcome && 'launch' in outcome);
  assert.equal(outcome.launch.kind, 'major');
});

test('repos without launch.yml, disabled ones and pre-releases are ignored without a record', async () => {
  const registry = new Registry(':memory:');
  const github = new FakeGitHub(
    [
      {
        notModified: false,
        etag: 'W/"1"',
        events: [
          release('103', 'yeyo11/beta', 'v2.0.0-rc.1', true),
          release('102', 'yeyo11/off', 'v1.0.0'),
          release('101', 'yeyo11/plain', 'v1.0.0'),
        ],
      },
    ],
    { 'yeyo11/off@v1.0.0': 'enabled: false\nbrand: personal\n' },
  );
  const outcomes = await detect({ github, registry, brand });
  assert.deepEqual(
    outcomes.map((o) => (o.result === 'ignored' ? o.reason : o.result)),
    ['no .github/launch.yml', 'launch.yml has enabled: false', 'a pre-release'],
  );
  assert.equal(registry.find('yeyo11/plain', 'v1.0.0'), undefined);
});

test('a launch.yml for another brand is refused: brands never mix', async () => {
  const registry = new Registry(':memory:');
  const github = new FakeGitHub(
    [{ notModified: false, etag: 'W/"1"', events: [release('100', 'yeyo11/tool', 'v1.0.0')] }],
    { 'yeyo11/tool@v1.0.0': 'enabled: true\nbrand: company\n' },
  );
  const [outcome] = await detect({ github, registry, brand });
  assert.equal(outcome?.result, 'ignored');
  assert.match(outcome?.result === 'ignored' ? outcome.reason : '', /brand "company", not "personal"/);
});

test('an invalid launch.yml is recorded as failed with its line, and not retried', async () => {
  const registry = new Registry(':memory:');
  const github = new FakeGitHub(
    [{ notModified: false, etag: 'W/"1"', events: [release('100', 'yeyo11/claudio', 'v0.9.0')] }],
    { 'yeyo11/claudio@v0.9.0': 'enabled: true\nbrand: personal\npublishing:\n  reddit: auto\n' },
  );
  const [outcome] = await detect({ github, registry, brand });
  assert.equal(outcome?.result, 'invalid-config');
  const launch = registry.find('yeyo11/claudio', 'v0.9.0');
  assert.equal(launch?.status, 'failed');
  assert.match(launch?.detail ?? '', /^\.github\/launch\.yml:4:\d+ publishing\.reddit: /);
});

test('events already seen are skipped, and a 304 costs nothing', async () => {
  const registry = new Registry(':memory:');
  const github = new FakeGitHub(
    [
      { notModified: false, etag: 'W/"1"', events: [release('100', 'yeyo11/claudio', 'v0.9.0')] },
      { notModified: true },
      {
        notModified: false,
        etag: 'W/"2"',
        events: [release('101', 'yeyo11/claudio', 'v0.9.1'), release('100', 'yeyo11/claudio', 'v0.9.0')],
      },
    ],
    { 'yeyo11/claudio@v0.9.0': VALID, 'yeyo11/claudio@v0.9.1': VALID },
  );

  assert.equal((await detect({ github, registry, brand })).length, 1);
  assert.deepEqual(await detect({ github, registry, brand }), []);
  const third = await detect({ github, registry, brand });
  assert.deepEqual(
    third.map((o) => o.event.id),
    ['101'],
    'only the new event is considered',
  );
  assert.deepEqual(
    github.calls.filter((c) => c.startsWith('events')),
    ['events yeyo11 -', 'events yeyo11 W/"1"', 'events yeyo11 W/"1"'],
    'every request after the first carries the last etag',
  );
});

test('a repo made public launches only when launch.yml enables that trigger', async () => {
  const registry = new Registry(':memory:');
  const event: GitHubEvent = { id: '200', type: 'public', repo: 'yeyo11/new', at: '2026-10-24T11:00:00Z' };
  const off = new FakeGitHub([{ notModified: false, etag: 'W/"1"', events: [event] }], { 'yeyo11/new@HEAD': VALID });
  const [ignored] = await detect({ github: off, registry, brand });
  assert.equal(ignored?.result, 'ignored');

  const registry2 = new Registry(':memory:');
  const on = new FakeGitHub([{ notModified: false, etag: 'W/"1"', events: [event] }], {
    'yeyo11/new@HEAD': `${VALID}triggers:\n  public: true\n`,
  });
  const [claimed] = await detect({ github: on, registry: registry2, brand });
  assert.equal(claimed?.result, 'claimed');
  assert.ok(claimed && 'launch' in claimed);
  assert.equal(claimed.launch.ref, 'public:200');
  assert.equal(claimed.launch.kind, 'launch');
});
