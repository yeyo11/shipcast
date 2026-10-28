import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Brand } from '@shipcast/schema';
import { detect, type EventsPage, type GitHubEvent } from '../src/index.ts';
import { FakeGitHub, memoryRegistry } from '../src/testing/index.ts';

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://example.dev', github: 'yeyo11' });

const VALID = 'enabled: true\nbrand: personal\n';

function release(id: string, repo: string, tag: string, prerelease = false): GitHubEvent {
  return { id, type: 'release', repo, tag, prerelease, url: `https://github.com/${repo}/releases/tag/${tag}`, at: '2026-10-24T10:00:00Z' };
}

/** A GitHub with fixed event pages and each repo's launch.yml by `owner/name@ref` */
function fakeGitHub(pages: EventsPage[], launchYmls: Record<string, string> = {}): FakeGitHub {
  const files = Object.fromEntries(Object.entries(launchYmls).map(([at, text]) => [at.replace('@', '/.github/launch.yml@'), text]));
  return new FakeGitHub({ events: pages, files });
}

test('a published release of an enabled repo is claimed, with the pack inferred from the version', async () => {
  const registry = await memoryRegistry();
  const github = fakeGitHub(
    [{ notModified: false, etag: 'W/"1"', events: [release('100', 'yeyo11/claudio', 'v0.9.0')] }],
    { 'yeyo11/claudio@v0.9.0': VALID },
  );
  const [outcome] = await detect({ github, registry, brand });
  assert.equal(outcome?.result, 'claimed');
  assert.ok(outcome && 'launch' in outcome);
  assert.equal(outcome.launch.kind, 'launch', 'the first launch of a project');
  assert.equal(outcome.launch.trigger, 'release');
  assert.ok(github.called('fileAt').some((args) => args.join(' ') === 'yeyo11/claudio .github/launch.yml v0.9.0'), 'launch.yml is read at the tag');
});

test('the next major after a published launch is a major pack', async () => {
  const registry = await memoryRegistry();
  const first = await registry.claim({ repo: 'yeyo11/claudio', ref: 'v0.8.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  await registry.setStatus(first.launch.id, 'published');
  const github = fakeGitHub(
    [{ notModified: false, etag: 'W/"1"', events: [release('100', 'yeyo11/claudio', 'v0.9.0')] }],
    { 'yeyo11/claudio@v0.9.0': VALID },
  );
  const [outcome] = await detect({ github, registry, brand });
  assert.ok(outcome && 'launch' in outcome);
  assert.equal(outcome.launch.kind, 'major');
});

test('repos without launch.yml, disabled ones and pre-releases are ignored without a record', async () => {
  const registry = await memoryRegistry();
  const github = fakeGitHub(
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
  assert.equal(await registry.find('yeyo11/plain', 'v1.0.0'), undefined);
});

test('a launch.yml for another brand is refused: brands never mix', async () => {
  const registry = await memoryRegistry();
  const github = fakeGitHub(
    [{ notModified: false, etag: 'W/"1"', events: [release('100', 'yeyo11/tool', 'v1.0.0')] }],
    { 'yeyo11/tool@v1.0.0': 'enabled: true\nbrand: company\n' },
  );
  const [outcome] = await detect({ github, registry, brand });
  assert.equal(outcome?.result, 'ignored');
  assert.match(outcome?.result === 'ignored' ? outcome.reason : '', /brand "company", not "personal"/);
});

test('an invalid launch.yml is recorded as failed with its line, and not retried', async () => {
  const registry = await memoryRegistry();
  const github = fakeGitHub(
    [{ notModified: false, etag: 'W/"1"', events: [release('100', 'yeyo11/claudio', 'v0.9.0')] }],
    { 'yeyo11/claudio@v0.9.0': 'enabled: true\nbrand: personal\npublishing:\n  reddit: manual\n' },
  );
  const [outcome] = await detect({ github, registry, brand });
  assert.equal(outcome?.result, 'invalid-config');
  const launch = await registry.find('yeyo11/claudio', 'v0.9.0');
  assert.equal(launch?.status, 'failed');
  assert.match(launch?.detail ?? '', /^\.github\/launch\.yml:4:\d+ publishing\.reddit: /);
});

test('events already seen are skipped, and a 304 costs nothing', async () => {
  const registry = await memoryRegistry();
  const github = fakeGitHub(
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
    github.called('userEvents'),
    [['yeyo11', undefined], ['yeyo11', 'W/"1"'], ['yeyo11', 'W/"1"']],
    'every request after the first carries the last etag',
  );
});

test('a repo made public launches only when launch.yml enables that trigger', async () => {
  const registry = await memoryRegistry();
  const event: GitHubEvent = { id: '200', type: 'public', repo: 'yeyo11/new', at: '2026-10-24T11:00:00Z' };
  const off = fakeGitHub([{ notModified: false, etag: 'W/"1"', events: [event] }], { 'yeyo11/new@HEAD': VALID });
  const [ignored] = await detect({ github: off, registry, brand });
  assert.equal(ignored?.result, 'ignored');

  const registry2 = await memoryRegistry();
  const on = fakeGitHub([{ notModified: false, etag: 'W/"1"', events: [event] }], {
    'yeyo11/new@HEAD': `${VALID}triggers:\n  public: true\n`,
  });
  const [claimed] = await detect({ github: on, registry: registry2, brand });
  assert.equal(claimed?.result, 'claimed');
  assert.ok(claimed && 'launch' in claimed);
  assert.equal(claimed.launch.ref, 'public:200');
  assert.equal(claimed.launch.kind, 'launch');
});
