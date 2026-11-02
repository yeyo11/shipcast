import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { draftLaunch, loadBrand, type GitHubRest } from '@shipcast/engine';
import { FakeGitHub, memoryRegistry } from '@shipcast/engine/testing';
import { CHANNEL_ADAPTERS, type AnyChannelAdapter } from '@shipcast/runtime';
import { UTM_CHANNELS, type TrackedChannel } from '@shipcast/schema';
import { ciPipeline, ciPublishLaunch } from '../src/ci.ts';
import { ACTION_CHANNELS, renderPublishWorkflow } from '../src/setup.ts';

/*
 * The links an Action-mode launch sends to each network (docs/tracking.md): a release drafted by the
 * fake AI provider, its drafts pull request merged, then `ci publish`'s own path (the publishers
 * built from the environment's secrets, `publishOne`). Every network's connector is replaced by one
 * that records what it is handed, so the test reads exactly what would leave for each network after
 * the channels' adapters tagged it: every link to the site carries the network and the launch's
 * campaign, and none keeps the `?ref=` the drafts are written with.
 */

const SITE = 'https://example.dev';
const LAUNCHES = 'me/launches';
const CAMPAIGN = 'app-v1-0-0';
const BRAND_YML = `id: personal
displayName: Me
site: ${SITE}
github: me
languages:
  blog: [en, es]
newsletter:
  sender: { name: Me, email: news@example.dev }
  lists: { en: 1, es: 2 }
`;
/** Every channel the Action publishes: the ones `init` offers, and the newsletter turned on by hand */
const CHANNELS = [...ACTION_CHANNELS, 'newsletter'] as const;
const LAUNCH_YML = `enabled: true\nbrand: personal\npublishing:\n${['instagram', 'reddit', 'linkedin', 'threads', 'youtube']
  .filter((c) => !(CHANNELS as readonly string[]).includes(c))
  .map((c) => `  ${c}: off\n`)
  .join('')}${CHANNELS.map((c) => `  ${c}: approval\n`).join('')}`;

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Sent {
  channel: string;
  method: string;
  args: unknown[];
}

/** A connector that answers every call as a network that took it, and records what it was handed */
function recordingConnector(channel: string, sent: Sent[]): unknown {
  return new Proxy(
    {},
    {
      get: (_target, method) => {
        // Never a thenable: a connector may be awaited as a value
        if (typeof method !== 'string' || method === 'then') return undefined;
        return async (...args: unknown[]) => {
          sent.push({ channel, method, args });
          if (method === 'subscribers') return 3;
          return { externalId: `${channel}-1`, url: `https://${channel}.example/1` };
        };
      },
    },
  );
}

/** The channels' own adapters (and so their tagging), over connectors that record instead of posting */
function recordingAdapters(sent: Sent[]): AnyChannelAdapter[] {
  return CHANNEL_ADAPTERS.map((adapter) => {
    const channel = adapter.definition.id;
    if (adapter.connect.kind === 'engine') return { ...adapter, connect: { ...adapter.connect, build: () => recordingConnector(channel, sent) } };
    const network = adapter.connect.network;
    return { ...adapter, connect: { ...adapter.connect, network: { ...network, build: () => ({ connector: recordingConnector(channel, sent), check: async () => ({ ok: true as const, account: channel }) }) } } } as AnyChannelAdapter;
  });
}

/** The site answering every read: the article live, the launch image served */
async function withLiveSite<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { 'content-type': 'image/jpeg' } })) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

/** Every URL in what a network was handed, however deep in it */
function urlsIn(value: unknown): string[] {
  const text = JSON.stringify(value, (_key, v: unknown) => (v instanceof Uint8Array ? undefined : v));
  return [...text.matchAll(/https?:\/\/[^\s"'<>\\)\]]+/g)].map((m) => m[0].replaceAll('&amp;', '&').replace(/[.,;:!?*]+$/, ''));
}

test('Action mode: a fake-provider launch publishes every link to the site with its UTM tags and no ?ref=', async () => {
  const github = new FakeGitHub({
    files: { [`${LAUNCHES}/brand.yml@HEAD`]: BRAND_YML, 'me/app/.github/launch.yml@v1.0.0': LAUNCH_YML },
    latestRelease: { tag: 'v1.0.0', url: 'u' },
  });
  const registry = await memoryRegistry();
  const hostPath = mkdtempSync(join(tmpdir(), 'shipcast-action-utm-'));
  dirs.push(hostPath);
  mkdirSync(join(hostPath, '.github'));
  writeFileSync(join(hostPath, '.github', 'launch.yml'), LAUNCH_YML);
  const base = {
    github,
    registry,
    launchesRepo: LAUNCHES,
    checkout: async () => ({ hostPath }),
    now: () => new Date('2026-11-02T00:00:00Z'),
    fetch: (async () => new Response(null, { status: 404 })) as typeof fetch,
  };
  const brand = await loadBrand(github, LAUNCHES);
  const { launch } = await registry.launches.claim({ repo: 'me/app', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });

  // `ci launch`: the fake provider's drafts, written with `?ref=<channel>` as a model writes them
  const drafted = await draftLaunch(launch, brand, ciPipeline({ kind: 'fake' }, base, { launch, brand }));
  assert.equal(drafted.ok, true, drafted.ok ? '' : drafted.problems.join('; '));
  const pr = [...github.pulls.values()][0]!;
  await github.mergePullRequest(LAUNCHES, pr.number, pr.title);

  // `ci publish`: the secrets the publish workflow `init` writes passes, every network's set
  const workflow = renderPublishWorkflow({ channels: [...ACTION_CHANNELS] });
  const env: NodeJS.ProcessEnv = Object.fromEntries([...[...workflow.matchAll(/^ {10}([A-Z_]+): /gm)].map(([, name]) => name!), 'BREVO_API_KEY'].map((name) => [name, 'set']));
  const sent: Sent[] = [];
  const stored = (await registry.launches.get(launch.id))!;
  const workDir = mkdtempSync(join(tmpdir(), 'shipcast-action-utm-work-'));
  dirs.push(workDir);
  const result = await withLiveSite(() =>
    ciPublishLaunch(stored, brand, { env, workDir, github: github as unknown as GitHubRest, registry, pipeline: ciPipeline(undefined, base), log: () => {}, adapters: recordingAdapters(sent) }),
  );
  assert.equal(result.state, 'published', JSON.stringify(result));

  const byChannel = new Map<string, string[]>();
  for (const call of sent) byChannel.set(call.channel, [...(byChannel.get(call.channel) ?? []), ...urlsIn(call.args).filter((u) => new URL(u).hostname === 'example.dev')]);
  const published = CHANNELS.filter((c) => c !== 'blog');
  assert.deepEqual([...byChannel.keys()].sort(), [...published].sort(), 'every channel the Action publishes was sent its piece');

  for (const channel of published) {
    const links = byChannel.get(channel)!;
    assert.ok(links.length > 0, `${channel} links the site`);
    for (const link of links) {
      const url = new URL(link);
      assert.equal(url.searchParams.has('ref'), false, `${channel}: ${link} keeps its ?ref=`);
      // The images a piece carries (the cover, the launch image) are the site's files, not a visit
      if (/\.(png|jpe?g)$/.test(url.pathname)) continue;
      if (channel === 'devto' || channel === 'hashnode') {
        // The canonical URL stays clean: the referrer names these networks already
        assert.equal(url.search, '', `${channel}: ${link} is canonical and untagged`);
        continue;
      }
      const tags = UTM_CHANNELS[channel as TrackedChannel];
      assert.ok(tags, `${channel} is a tagged channel`);
      assert.equal(url.searchParams.get('utm_source'), tags.source, `${channel}: ${link}`);
      assert.equal(url.searchParams.get('utm_medium'), tags.medium, `${channel}: ${link}`);
      assert.equal(url.searchParams.get('utm_campaign'), CAMPAIGN, `${channel}: ${link}`);
      if (channel === 'newsletter') assert.match(url.searchParams.get('utm_content') ?? '', /^(en|es)$/, `${channel}: ${link} names its issue's language`);
      else assert.equal(url.searchParams.has('utm_content'), false, `${channel}: ${link}`);
    }
  }
  assert.doesNotMatch(JSON.stringify(sent.map((s) => s.args)), /[?&]ref=/, 'no ?ref= leaves for any network');
});
