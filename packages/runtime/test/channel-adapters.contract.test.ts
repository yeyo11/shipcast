import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Published } from '@shipcast/connectors';
import { GitHubRest, PublishingService, textPostStrategy, type TextPostPublisher } from '@shipcast/engine';
import { aLaunch, FakeGitHub, LAUNCHES_REPO, memoryRegistry } from '@shipcast/engine/testing';
import { Brand, CHANNEL_DEFINITIONS, type ChannelDefinition } from '@shipcast/schema';
import {
  ACTION_VARIABLES,
  buildConnector,
  buildServices,
  CHANNEL_ADAPTERS,
  catalogOf,
  channelAdapter,
  MemoryStore,
  MissingField,
  NETWORK_VARIABLES,
  NETWORKS,
  networkOf,
  SETTINGS,
  settingDefinition,
  VARIABLE_HOW,
  type AnyChannelAdapter,
  type SettingName,
} from '../src/index.ts';

/*
 * Every channel's adapter half against its definition, and what the tables derived from the adapters
 * held before they were derived (the catalog, the Action's variables, the OAuth apps' settings). A new
 * network passes these or the suite says what it lacks.
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
const noNetwork = (async () => {
  throw new Error('no network in this test');
}) as typeof fetch;

/** An adapter's connector, built with a placeholder for each value it asks for: constructors do no I/O */
function connectorOf(adapter: AnyChannelAdapter): unknown {
  if (adapter.connect.kind === 'engine') return adapter.connect.build({ auth: { token: async () => 't' }, fetch: noNetwork });
  const values: Record<string, string> = {};
  for (let i = 0; i < 20; i++) {
    try {
      return buildConnector(adapter.connect.network.id, { settings: values, secrets: {} }, brand, noNetwork, { adapters: [adapter] }).connector;
    } catch (error) {
      const key = error instanceof MissingField ? / needs (\w+)$/.exec(error.message)?.[1] : undefined;
      if (!key) throw error;
      values[key] = 'https://example.test';
    }
  }
  throw new Error(`${adapter.definition.id} asks for too many values`);
}

const has = (value: unknown, method: string) => typeof (value as Record<string, unknown> | undefined)?.[method] === 'function';

test('the catalog lists the networks it did before the adapters, in the same order, named by the definitions', () => {
  const before = new Set(['devto', 'bluesky', 'mastodon', 'instagram', 'threads', 'linkedin', 'reddit', 'brevo', 'hashnode', 'telegram', 'discord', 'cloudflare', 'searchConsole', 'bingWebmaster', 'anthropic', 'openaiCompatible']);
  assert.deepEqual(
    NETWORKS.filter((n) => before.has(n.id)).map((n) => [n.id, n.name, n.channel ?? null, n.metrics, n.auth]),
    [
      ['devto', 'dev.to', 'devto', true, 'form'],
      ['bluesky', 'Bluesky', 'bluesky', true, 'form'],
      ['mastodon', 'Mastodon', 'mastodon', true, 'oauth'],
      ['instagram', 'Instagram', 'instagram', true, 'oauth'],
      ['threads', 'Threads', 'threads', true, 'oauth'],
      ['linkedin', 'LinkedIn', 'linkedin', false, 'oauth'],
      ['reddit', 'Reddit', 'reddit', false, 'oauth'],
      ['brevo', 'Newsletter (Brevo)', 'newsletter', true, 'form'],
      ['hashnode', 'Hashnode', 'hashnode', true, 'form'],
      ['telegram', 'Telegram', 'telegram', false, 'form'],
      ['discord', 'Discord', 'discord', false, 'form'],
      ['cloudflare', 'Blog analytics (Cloudflare)', null, true, 'form'],
      ['searchConsole', 'Google Search Console', null, true, 'form'],
      ['bingWebmaster', 'Bing Webmaster Tools', null, true, 'form'],
      ['anthropic', 'Anthropic API', null, false, 'form'],
      ['openaiCompatible', 'OpenAI-compatible server', null, false, 'form'],
    ],
  );
});

test("the Action's variables and how to get them are what the hand-written tables said", () => {
  const before: Record<string, string[][]> = {
    blog: [[]],
    githubDiscussions: [[]],
    devto: [['DEVTO_API_KEY']],
    bluesky: [['BLUESKY_HANDLE', 'BLUESKY_APP_PASSWORD'], ['BLUESKY_APP_PASSWORD']],
    mastodon: [['MASTODON_INSTANCE', 'MASTODON_ACCESS_TOKEN'], ['MASTODON_ACCESS_TOKEN']],
    instagram: [['INSTAGRAM_USER_ID', 'INSTAGRAM_ACCESS_TOKEN']],
    hashnode: [['HASHNODE_TOKEN', 'HASHNODE_PUBLICATION_HOST']],
    telegram: [['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']],
    discord: [['DISCORD_WEBHOOK_URL']],
    newsletter: [['BREVO_API_KEY']],
  };
  for (const [channel, sets] of Object.entries(before)) assert.deepEqual(ACTION_VARIABLES[channel as keyof typeof ACTION_VARIABLES], sets, channel);
  for (const channel of ['reddit', 'linkedin', 'threads'] as const) assert.equal(ACTION_VARIABLES[channel], undefined, `${channel} signs in through the app`);
  assert.deepEqual(NETWORK_VARIABLES.slice(0, 19), [
    'DEVTO_API_KEY', 'BLUESKY_HANDLE', 'BLUESKY_APP_PASSWORD', 'MASTODON_INSTANCE', 'MASTODON_ACCESS_TOKEN', 'INSTAGRAM_USER_ID', 'INSTAGRAM_ACCESS_TOKEN',
    'BREVO_API_KEY', 'HASHNODE_TOKEN', 'HASHNODE_PUBLICATION_HOST', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_NOTIFY_CHAT_ID', 'DISCORD_WEBHOOK_URL',
    'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_WEB_ANALYTICS_SITE_TAG', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'BING_WEBMASTER_API_KEY',
  ]);
  assert.equal(VARIABLE_HOW.DEVTO_API_KEY, 'https://dev.to/settings/extensions (DEV Community API Keys)');
  assert.equal(VARIABLE_HOW.TELEGRAM_CHAT_ID, 'your channel, like @yourchannel');
  assert.equal(Object.keys(VARIABLE_HOW).length >= 10, true);
});

test("each OAuth network's app is two settings, named and kept as before", () => {
  const app = (name: SettingName) => {
    const d = settingDefinition(name);
    return [d.env, d.store.kind, d.store.key, d.label];
  };
  assert.deepEqual(app('instagramAppId'), ['INSTAGRAM_APP_ID', 'setting', 'instagram-app-id', 'The Instagram app id']);
  assert.deepEqual(app('instagramAppSecret'), ['INSTAGRAM_APP_SECRET', 'secret', 'app:instagram-app-secret', 'The Instagram app secret']);
  assert.deepEqual(app('threadsAppId'), ['THREADS_APP_ID', 'setting', 'threads-app-id', 'The Threads app id']);
  assert.deepEqual(app('linkedinClientSecret'), ['LINKEDIN_CLIENT_SECRET', 'secret', 'app:linkedin-client-secret', 'The LinkedIn client secret']);
  assert.deepEqual(app('redditClientId'), ['REDDIT_CLIENT_ID', 'setting', 'reddit-client-id', 'The Reddit client id']);
  assert.deepEqual(Object.keys(SETTINGS).slice(0, 3), ['launchesRepo', 'claudioUrl', 'claudioToken']);
});

test('every channel the engine publishes has an adapter, and only those', () => {
  const engine = CHANNEL_DEFINITIONS.filter((d) => d.publishedBy === 'engine').map((d) => d.id).sort();
  assert.deepEqual(CHANNEL_ADAPTERS.map((a) => a.definition.id).sort(), engine);
  const networks = CHANNEL_ADAPTERS.flatMap((a) => networkOf(a)?.id ?? []);
  assert.equal(new Set(networks).size, networks.length, 'one adapter per network');
});

for (const adapter of CHANNEL_ADAPTERS) {
  const d: ChannelDefinition = adapter.definition;
  test(`${d.id}: the adapter wires what the definition declares, and nothing else`, () => {
    const connector = connectorOf(adapter);
    assert.ok(has(adapter.publisher(connector), 'publish') || has(adapter.publisher(connector), 'send'), 'it publishes');
    const editor = adapter.editor?.(connector);
    assert.equal(has(editor, 'edit'), d.edit.edit !== 'no', 'edit');
    assert.equal(has(editor, 'delete'), d.edit.delete !== 'no', 'delete');
    const comments = adapter.comments?.(connector);
    assert.equal(comments?.reader !== undefined, d.comments?.read ?? false, 'comments read');
    assert.equal(comments?.replier !== undefined, d.comments?.reply ?? false, 'comments answered');
    assert.equal(adapter.metrics !== undefined, d.metrics !== undefined, 'numbers read');
    assert.equal(has(adapter.metrics?.(connector), 'analytics'), d.metrics?.analytics !== undefined, 'analytics read on their own cadence');
    const spec = networkOf(adapter);
    if (spec) {
      const values: Record<string, string> = {};
      // The profile's capabilities are what the connection offers, built as connectorOf builds it
      for (let i = 0; i < 20; i++) {
        try {
          const connection = buildConnector(spec.id, { settings: values, secrets: {} }, brand, noNetwork, { adapters: [adapter] });
          assert.equal(connection.profile !== undefined, d.profile?.read ?? false, 'profile read');
          assert.equal(connection.editProfile !== undefined, d.profile?.edit === 'yes', 'profile edited');
          break;
        } catch (error) {
          const key = error instanceof MissingField ? / needs (\w+)$/.exec(error.message)?.[1] : undefined;
          if (!key) throw error;
          values[key] = 'https://example.test';
        }
      }
      assert.ok(spec.permissions.length > 0 && spec.howTo.trim(), 'it says what it does and how to connect it');
      if (spec.auth === 'form') assert.ok(spec.fields.length > 0, 'a form asks something');
    }
  });
}

/** A network that is not there: one definition, one adapter, and the lines that list them */
class PigeonPost implements TextPostPublisher {
  readonly sent: Array<{ text: string; link: string }> = [];
  readonly loft: string;
  constructor(loft: string) {
    this.loft = loft;
  }
  async publish(post: { text: string; link: string; imageUrl: string }): Promise<Published> {
    this.sent.push({ text: post.text, link: post.link });
    return { externalId: `coo-${this.sent.length}`, url: `https://pigeon.example/${this.sent.length}` };
  }
  async check() {
    return { ok: true as const, account: this.loft };
  }
}

/** Every pigeon connector built, to read what was sent */
const lofts: PigeonPost[] = [];

const pigeon = {
  id: 'pigeon',
  name: 'Pigeon',
  inSentence: 'Pigeon',
  icon: 'pigeon',
  // launch.yml cannot name a channel the schema's registry lacks: the test's runs in its default mode
  defaultMode: 'auto',
  group: 'social',
  publishedBy: 'engine',
  idempotent: false,
  schedulable: false,
  pack: { key: 'pigeon', piece: ({ z }) => z.strictObject({ text: z.string() }).optional() },
  brief: 'pigeon: one note.',
  draft: { file: () => ({ name: 'pigeon.md', title: 'Pigeon' }), match: (n: string) => (n === 'pigeon.md' ? '' : undefined), read: (body: string) => ({ text: body }) },
  limits: {},
  edit: { edit: 'no', delete: 'no', note: 'Paper does not take edits', fields: [], main: 'post' },
} as const satisfies ChannelDefinition<'pigeon'>;

const pigeonAdapter = channelAdapter({
  definition: pigeon,
  connect: {
    kind: 'account',
    network: {
      id: 'pigeon',
      auth: 'form',
      fields: [{ key: 'loft', label: 'Loft', secret: true }],
      permissions: ['Sends one note per launch'],
      howTo: 'Ask the loft.',
      env: [{ name: 'PIGEON_LOFT', key: 'loft', secret: true }],
      build: ({ need }) => {
        const connector = new PigeonPost(need('loft'));
        lofts.push(connector);
        return { connector, check: () => connector.check() };
      },
    },
  },
  publisher: (c: PigeonPost): TextPostPublisher => c,
  strategy: textPostStrategy(pigeon),
});

test('a network added as one definition and one adapter is in the catalog, builds its services and publishes', async () => {
  const adapters = [...CHANNEL_ADAPTERS, pigeonAdapter];
  const channels = [...CHANNEL_DEFINITIONS, pigeon];
  assert.deepEqual(
    catalogOf(adapters).find((n) => n.id === 'pigeon'),
    { id: 'pigeon', name: 'Pigeon', channel: 'pigeon', metrics: false, auth: 'form', fields: [{ key: 'loft', label: 'Loft', secret: true }], permissions: ['Sends one note per launch'], howTo: 'Ask the loft.' },
  );

  const registry = await memoryRegistry();
  const services = await buildServices({ env: { PIGEON_LOFT: 'roof' }, brand, registry, github: new GitHubRest({ token: 'g' }), secrets: new MemoryStore(), adapters, fetch: noNetwork });
  assert.ok(services.configured.includes('pigeon'));
  assert.deepEqual(services.origins.pigeon, { kind: 'env' });
  assert.ok(services.strategies.pigeon, 'its strategy is bound to its publisher');

  const D = 'launches/claudio/v1.0.0';
  const pack = {
    schemaVersion: 1,
    kind: 'launch',
    project: { name: 'claudio', repo: 'https://github.com/yeyo11/claudio', version: 'v1.0.0' },
    analysis: { summary: 's', implemented: ['x'], planned: [], documentedOnly: [], limitations: [] },
    article: { en: { slug: 'claudio', title: 'T', description: 'D', markdown: 'B' } },
    pigeon: { text: 'from the pack' },
  };
  const github = new FakeGitHub({
    pullRequestState: 'merged',
    files: {
      [`${LAUNCHES_REPO}/${D}/pack.json@HEAD`]: JSON.stringify(pack),
      [`${LAUNCHES_REPO}/${D}/pigeon.md@HEAD`]: '# Pigeon\n\n> **Auto:** published without waiting.\n\nas the owner edited it',
      [`${LAUNCHES_REPO}/src/content/posts/en/claudio.md@HEAD`]: '---\ntitle: "Title"\ndescription: "Description"\n---\n\nBody.\n',
      'yeyo11/claudio/.github/launch.yml@v1.0.0': 'enabled: true\nbrand: personal\npublishing:\n  devto: off\n  instagram: off\n  githubDiscussions: off\n',
    },
  });
  const launch = await aLaunch(registry);
  const service = new PublishingService({ registry, github, launchesRepo: LAUNCHES_REPO });
  const site = (async () => new Response(null, { status: 200 })) as typeof fetch;
  // The pack carries a piece the schema's registry does not know: the publishing reads it from the parsed pack
  const result = await service.publish(launch, brand, { publishers: services.publishers, strategies: services.strategies, channels, fetch: site }, 'test');
  assert.equal(result.state, 'published', JSON.stringify(result));
  const posts = await registry.posts.posts(launch.id, { channel: 'pigeon' as never });
  assert.deepEqual(posts.map((p) => [p.kind, p.externalId, p.url]), [['post', 'coo-1', 'https://pigeon.example/1']]);
  assert.deepEqual(lofts.at(-1)?.sent, [{ text: 'as the owner edited it', link: 'https://josegarrido.dev/en/claudio/?ref=pigeon' }], 'the draft as merged, with the article');
});
