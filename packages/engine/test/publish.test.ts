import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorError } from '@shipcast/connectors';
import { Brand, parseLaunchConfig } from '@shipcast/schema';
import { cancelScheduledPost, deletePost, draftBody, publishLaunch, reschedulePost, scheduleLaunch, ScheduleRefused, type Registry, type EventsPage, type GitHubSource, type Publishers } from '../src/index.ts';
import { memoryRegistry } from '../src/testing.ts';

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
const D = 'launches/claudio/v0.8.2';

const pack = {
  schemaVersion: 1,
  kind: 'launch',
  project: { name: 'claudio', repo: 'https://github.com/yeyo11/claudio', version: 'v0.8.2' },
  analysis: { summary: 's', implemented: ['x'], planned: [], documentedOnly: [], limitations: [] },
  article: { en: { slug: 'claudio', title: 'AI title', description: 'AI description', markdown: 'AI body' } },
  devto: { tags: ['ai'] },
  bluesky: { lang: 'en', text: 'AI bluesky' },
  mastodon: { lang: 'en', text: 'AI mastodon' },
  instagram: { caption: 'AI caption', summary: 'Claude Code as a service.', slides: [{ title: 'Chats', text: 'From anywhere.' }, { title: 'Agents', text: 'In parallel.' }] },
  reddit: [{ subreddit: 'ClaudeAI', title: 't', body: 'b' }],
};

/** The launches repo after the merge, with the owner's edits in the drafts. */
const merged: Record<string, string> = {
  [`yeyo11/launches/${D}/pack.json@HEAD`]: JSON.stringify(pack),
  'yeyo11/launches/src/content/posts/en/claudio.md@HEAD': '---\ntitle: "Edited title"\ndescription: "Edited description"\n---\n\nEdited body.\n',
  [`yeyo11/launches/${D}/devto.md@HEAD`]: '# dev.to\n\n> **Approval:** x\n\nRepublishes…\n\nTags: `claude`, `selfhosted`\n',
  [`yeyo11/launches/${D}/bluesky.md@HEAD`]: '# Bluesky\n\n> **Approval:** x\n\nEdited bluesky https://josegarrido.dev/en/claudio/?ref=bluesky\n',
  [`yeyo11/launches/${D}/mastodon.md@HEAD`]: '# Mastodon\n\n> **Approval:** x\n\nEdited mastodon #claude\n',
  [`yeyo11/launches/${D}/instagram.md@HEAD`]: '# Instagram\n\n> **Approval:** x\n\nCarousel:\n\n1. Cover\n\nComment: Edited comment\n\n---\n\nEdited caption. Link in bio.\n',
  'yeyo11/claudio/.github/launch.yml@v0.8.2': 'enabled: true\nbrand: personal\nreddit:\n  subreddits: [ClaudeAI]\n',
};

class FakeGitHub implements GitHubSource {
  state: 'open' | 'merged' | 'closed';
  files: Record<string, string>;
  constructor(state: 'open' | 'merged' | 'closed', files = merged) {
    this.state = state;
    this.files = files;
  }
  async userEvents(): Promise<EventsPage> {
    return { notModified: true };
  }
  async fileAt(repo: string, path: string, ref: string) {
    return this.files[`${repo}/${path}@${ref}`];
  }
  async latestRelease() {
    return undefined;
  }
  async pullRequestState() {
    return this.state;
  }
}

/** The deployed site: which URLs answer, and the image bytes. */
function site(live: boolean): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (!live) return new Response(null, { status: 404 });
    if (url.endsWith('/og.jpg')) return new Response(new Uint8Array([0xff, 0xd8, 0xff]));
    return new Response(null, { status: 200 });
  }) as typeof fetch;
}

function recorder() {
  const calls: Array<{ channel: string; input: unknown }> = [];
  const ok = (channel: string) => async (input: unknown) => {
    calls.push({ channel, input });
    return { externalId: `${channel}-1`, url: `https://${channel}.example/1` };
  };
  const publishers: Publishers = { devto: { publish: ok('devto') }, bluesky: { publish: ok('bluesky') }, mastodon: { publish: ok('mastodon') }, instagram: { publish: ok('instagram') } };
  return { calls, publishers };
}

async function drafted(registry: Registry) {
  const { launch } = await registry.claim({ repo: 'yeyo11/claudio', ref: 'v0.8.2', trigger: 'release', kind: 'launch', brand: 'personal' });
  return registry.setStatus(launch.id, 'drafted', 'https://github.com/yeyo11/launches/pull/3');
}

test('a draft body is what follows its mode line', () => {
  assert.equal(draftBody('# Bluesky\n\n> **Approval:** published when merged.\n\nThe post.\n'), 'The post.');
});

test('nothing is published while the drafts pull request is open, nor before the site is live', async () => {
  const registry = await memoryRegistry();
  const launch = await drafted(registry);
  const { calls, publishers } = recorder();
  const open = await publishLaunch(launch, brand, { github: new FakeGitHub('open'), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(true) });
  assert.equal(open.state, 'waiting');
  const notLive = await publishLaunch(launch, brand, { github: new FakeGitHub('merged'), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(false) });
  assert.deepEqual(notLive.state === 'waiting' && notLive.reason, 'https://josegarrido.dev/en/claudio/ is not live yet');
  assert.equal(calls.length, 0);
});

test('a drafts pull request closed without merging skips the launch', async () => {
  const registry = await memoryRegistry();
  const result = await publishLaunch(await drafted(registry), brand, { github: new FakeGitHub('closed'), registry, launchesRepo: 'yeyo11/launches', publishers: {}, fetch: site(true) });
  assert.equal(result.state, 'skipped');
  assert.match(result.launch.detail ?? '', /closed without merging/);
});

test('after the merge every approval channel is published with the edited texts, once', async () => {
  const registry = await memoryRegistry();
  const launch = await drafted(registry);
  const { calls, publishers } = recorder();
  const devto = await registry.addAccount({ network: 'devto', brand: 'personal', label: '@me', settings: {} });
  const deps = { github: new FakeGitHub('merged'), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(true), accounts: { devto: devto.id } };

  const result = await publishLaunch(launch, brand, deps);
  assert.equal(result.state, 'published');
  assert.deepEqual(calls.map((c) => c.channel), ['devto', 'bluesky', 'mastodon', 'instagram'], 'Reddit has no publisher here');

  const input = (channel: string) => calls.find((c) => c.channel === channel)!.input as Record<string, unknown>;
  assert.deepEqual(input('devto'), {
    title: 'Edited title',
    markdown: 'Edited body.',
    tags: ['claude', 'selfhosted'],
    canonicalUrl: 'https://josegarrido.dev/en/claudio/',
    mainImage: 'https://josegarrido.dev/launches/claudio/v0.8.2/og.png',
  });
  assert.equal(input('bluesky').text, 'Edited bluesky https://josegarrido.dev/en/claudio/?ref=bluesky');
  assert.equal((input('bluesky').link as { title: string }).title, 'Edited title');
  assert.equal(input('mastodon').text, 'Edited mastodon #claude');
  assert.equal(input('mastodon').idempotencyKey, `shipcast-${launch.id}-mastodon`);
  assert.deepEqual(input('instagram'), {
    caption: 'Edited caption. Link in bio.',
    media: ['01', '02', '03', '04'].map((n) => ({ kind: 'image', url: `https://josegarrido.dev/launches/claudio/v0.8.2/instagram-${n}.jpg` })),
  });

  assert.equal((await registry.get(launch.id))!.status, 'published');
  assert.deepEqual((await registry.posts(launch.id)).map((p) => p.channel).sort(), ['blog', 'bluesky', 'devto', 'instagram', 'mastodon']);
  const [article] = await registry.posts(launch.id, { channel: 'blog' });
  assert.deepEqual([article?.kind, article?.url, article?.externalId, article?.accountId], ['article:en', 'https://josegarrido.dev/en/claudio/', 'claudio', null]);
  const [onDevto] = await registry.posts(launch.id, { channel: 'devto' });
  assert.deepEqual([onDevto?.kind, onDevto?.accountId, onDevto?.externalId], ['post', devto.id, 'devto-1'], 'the account it went out with');
  assert.equal((await registry.posts(launch.id, { channel: 'bluesky' }))[0]?.accountId, null, 'credentials from .env have no account');

  await publishLaunch((await registry.get(launch.id))!, brand, deps);
  assert.equal(calls.length, 4, 'a second round publishes nothing again');
});

test('a temporary failure leaves the launch partial and is retried; a permanent one is recorded and not retried', async () => {
  const registry = await memoryRegistry();
  const launch = await drafted(registry);
  const { calls, publishers } = recorder();
  let mastodonTries = 0;
  publishers.mastodon = {
    publish: async () => {
      mastodonTries++;
      if (mastodonTries === 1) throw new ConnectorError('Mastodon', 'publish: 503', 503);
      return { externalId: 'm', url: 'https://mastodon.example/m' };
    },
  };
  publishers.instagram = {
    publish: async () => {
      throw new ConnectorError('Instagram', 'publish: 400 invalid token', 400);
    },
  };
  const deps = { github: new FakeGitHub('merged'), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(true) };

  const first = await publishLaunch(launch, brand, deps);
  assert.equal(first.state, 'partial');
  assert.ok(first.state === 'partial' && first.problems.some((p) => p.startsWith('mastodon:') && p.endsWith('(will retry)')));
  assert.ok(first.state === 'partial' && first.problems.some((p) => p.startsWith('instagram:') && !p.endsWith('(will retry)')));

  const second = await publishLaunch((await registry.get(launch.id))!, brand, deps);
  assert.equal(second.state, 'published', 'Mastodon went through; Instagram is not retried');
  assert.equal(mastodonTries, 2);
  assert.equal(calls.filter((c) => c.channel === 'devto').length, 1);
});

test('the newsletter sends one campaign per language with the edited issue, and skips an empty list', async () => {
  const withNewsletter = Brand.parse({
    id: 'personal',
    displayName: 'Me',
    site: 'https://josegarrido.dev',
    github: 'yeyo11',
    newsletter: { sender: { name: 'Me', email: 'hola@josegarrido.dev' }, lists: { en: 3, es: 4 } },
  });
  const issue = (s: string) => ({ subject: `${s} subject`, previewText: `${s} preview`, markdown: `${s} body` });
  const files = {
    ...merged,
    [`yeyo11/launches/${D}/pack.json@HEAD`]: JSON.stringify({ ...pack, newsletter: { en: issue('AI en'), es: issue('AI es') } }),
    [`yeyo11/launches/${D}/newsletter-en.md@HEAD`]: '# Newsletter (en)\n\n> **Approval:** x\n\nSubject: Edited subject\nPreview: Edited preview\n\nEdited **issue**.\n',
    'yeyo11/claudio/.github/launch.yml@v0.8.2': 'enabled: true\nbrand: personal\npublishing:\n  newsletter: approval\nreddit:\n  subreddits: [ClaudeAI]\n',
  };
  const registry = await memoryRegistry();
  const launch = await drafted(registry);
  const sends: Array<{ listId: number; subject: string; previewText: string; html: string }> = [];
  const publishers: Publishers = {
    newsletter: {
      subscribers: async (listId) => (listId === 3 ? 12 : 0),
      send: async (c) => (sends.push(c), { externalId: '901', url: 'https://app.brevo.com/marketing-campaign/report/901' }),
    },
  };
  const result = await publishLaunch(launch, withNewsletter, { github: new FakeGitHub('merged', files), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(true) });

  assert.equal(sends.length, 1, 'the Spanish list has nobody yet');
  assert.equal(sends[0]!.listId, 3);
  assert.equal(sends[0]!.subject, 'Edited subject');
  assert.equal(sends[0]!.previewText, 'Edited preview');
  assert.match(sends[0]!.html, /Edited <strong>issue<\/strong>\./);
  assert.match(sends[0]!.html, /https:\/\/josegarrido\.dev\/en\/claudio\/\?ref=newsletter/);
  assert.match(sends[0]!.html, /\{\{ unsubscribe \}\}/);
  assert.ok(result.state === 'partial' || result.state === 'published');
  assert.deepEqual(
    (await registry.posts(launch.id, { channel: 'newsletter' })).map((p) => [p.kind, p.externalId, p.url]),
    [['issue:en', '901', 'https://app.brevo.com/marketing-campaign/report/901']],
  );
  assert.deepEqual(await registry.cursorsWithPrefix('newsletter-sent:'), [], 'the rows are the record');

  await publishLaunch((await registry.get(launch.id))!, withNewsletter, { github: new FakeGitHub('merged', files), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(true) });
  assert.equal(sends.length, 1, 'never sent twice');
});

test('a newsletter with nobody subscribed is recorded once and not retried', async () => {
  const withNewsletter = Brand.parse({
    id: 'personal',
    displayName: 'Me',
    site: 'https://josegarrido.dev',
    github: 'yeyo11',
    newsletter: { sender: { name: 'Me', email: 'hola@josegarrido.dev' }, lists: { en: 3 } },
  });
  const files = {
    ...merged,
    [`yeyo11/launches/${D}/pack.json@HEAD`]: JSON.stringify({ ...pack, newsletter: { en: { subject: 's', previewText: 'p', markdown: 'm' } } }),
    'yeyo11/claudio/.github/launch.yml@v0.8.2': 'enabled: true\nbrand: personal\npublishing:\n  newsletter: approval\nreddit:\n  subreddits: [ClaudeAI]\n',
  };
  const registry = await memoryRegistry();
  const launch = await drafted(registry);
  let reads = 0;
  const publishers: Publishers = { newsletter: { subscribers: async () => (reads++, 0), send: async () => assert.fail('nothing to send') } };
  const deps = { github: new FakeGitHub('merged', files), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(true) };
  const first = await publishLaunch(launch, withNewsletter, deps);
  assert.ok(first.state !== 'waiting' && first.state !== 'skipped');
  assert.match(first.state === 'published' || first.state === 'partial' ? first.problems.join() : '', /no subscribers yet in the en list/);
  await publishLaunch((await registry.get(launch.id))!, withNewsletter, deps);
  assert.equal(reads, 1);
});

test('after the Instagram carousel, its story and the edited comment go out once; their failures never repost it', async () => {
  const registry = await memoryRegistry();
  const launch = await drafted(registry);
  const done: string[] = [];
  let commentTries = 0;
  const publishers: Publishers = {
    instagram: {
      publish: async () => (done.push('post'), { externalId: 'post-1', url: 'https://www.instagram.com/p/1/' }),
      publishStory: async (m) => (done.push(`story ${m.url.split('/').at(-1)}`), { externalId: 'story-1', url: 'https://www.instagram.com/s/1/' }),
      comment: async (id, message) => {
        commentTries++;
        if (commentTries === 1) throw new ConnectorError('Instagram', 'comment: 403 missing permission', 403);
        done.push(`comment ${id}: ${message}`);
        return { id: 'c-1' };
      },
    },
  };
  const deps = { github: new FakeGitHub('merged'), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(true) };
  const first = await publishLaunch(launch, brand, deps);
  assert.ok(first.state === 'published' && first.problems.some((p) => p.startsWith('instagram comment: Instagram: comment: 403')));
  assert.deepEqual(done, ['post', 'story instagram-story.jpg']);
  assert.deepEqual(
    (await registry.posts(launch.id, { channel: 'instagram' })).map((p) => [p.kind, p.externalId]),
    [
      ['post', 'post-1'],
      ['story', 'story-1'],
    ],
  );
  assert.deepEqual(await registry.cursorsWithPrefix('instagram-'), [], 'the rows are the record');
});

test('the Instagram comment is its own row, and a second round neither reposts nor comments again', async () => {
  const registry = await memoryRegistry();
  const launch = await drafted(registry);
  const account = await registry.addAccount({ network: 'instagram', brand: 'personal', label: '@me', settings: {} });
  const done: string[] = [];
  const publishers: Publishers = {
    instagram: {
      publish: async () => (done.push('post'), { externalId: 'post-1', url: 'https://www.instagram.com/p/1/' }),
      comment: async (id) => (done.push(`comment ${id}`), { id: 'c-1' }),
    },
  };
  const deps = { github: new FakeGitHub('merged'), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(true), accounts: { instagram: account.id } };
  await publishLaunch(launch, brand, deps);
  await registry.setStatus(launch.id, 'drafted', launch.detail);
  await publishLaunch((await registry.get(launch.id))!, brand, deps);
  assert.deepEqual(done, ['post', 'comment post-1']);
  assert.deepEqual(
    (await registry.posts(launch.id, { channel: 'instagram' })).map((p) => [p.kind, p.externalId, p.url, p.accountId]),
    [
      ['post', 'post-1', 'https://www.instagram.com/p/1/', account.id],
      ['comment', 'c-1', null, account.id],
    ],
  );
});

test('a newsletter issue that went out is kept when the other language fails, and only that one is retried', async () => {
  const withNewsletter = Brand.parse({
    id: 'personal',
    displayName: 'Me',
    site: 'https://josegarrido.dev',
    github: 'yeyo11',
    newsletter: { sender: { name: 'Me', email: 'hola@josegarrido.dev' }, lists: { en: 3, es: 4 } },
  });
  const issue = { subject: 's', previewText: 'p', markdown: 'm' };
  const files = {
    ...merged,
    [`yeyo11/launches/${D}/pack.json@HEAD`]: JSON.stringify({ ...pack, newsletter: { en: issue, es: issue } }),
    'yeyo11/claudio/.github/launch.yml@v0.8.2': 'enabled: true\nbrand: personal\npublishing:\n  newsletter: approval\nreddit:\n  subreddits: [ClaudeAI]\n',
  };
  const registry = await memoryRegistry();
  const launch = await drafted(registry);
  const sends: number[] = [];
  let spanishTries = 0;
  const publishers: Publishers = {
    newsletter: {
      subscribers: async () => 5,
      send: async (c) => {
        if (c.listId === 4 && ++spanishTries === 1) throw new ConnectorError('Brevo', 'create the campaign: 502', 502);
        sends.push(c.listId);
        return { externalId: String(900 + c.listId), url: `https://app.brevo.com/marketing-campaign/report/${900 + c.listId}` };
      },
    },
  };
  const deps = { github: new FakeGitHub('merged', files), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(true) };
  const first = await publishLaunch(launch, withNewsletter, deps);
  assert.equal(first.state, 'partial');
  assert.deepEqual((await registry.posts(launch.id, { channel: 'newsletter' })).map((p) => p.kind), ['issue:en']);

  const second = await publishLaunch((await registry.get(launch.id))!, withNewsletter, deps);
  assert.equal(second.state, 'published');
  assert.deepEqual(sends, [3, 4], 'English once, Spanish once it went through');
  assert.deepEqual(
    (await registry.posts(launch.id, { channel: 'newsletter' })).map((p) => [p.kind, p.externalId]).sort(),
    [
      ['issue:en', '903'],
      ['issue:es', '904'],
    ],
  );
});

test('Hashnode, Telegram and Discord are published with the edited drafts', async () => {
  const files = {
    ...merged,
    [`yeyo11/launches/${D}/pack.json@HEAD`]: JSON.stringify({
      ...pack,
      hashnode: { tags: ['ai'] },
      telegram: { text: 'AI telegram' },
      discord: { text: 'AI discord' },
    }),
    [`yeyo11/launches/${D}/hashnode.md@HEAD`]: '# Hashnode\n\n> **Approval:** x\n\nRepublishes…\n\nTags: `claude`, `typescript`\n',
    [`yeyo11/launches/${D}/telegram.md@HEAD`]: '# Telegram\n\n> **Approval:** x\n\nEdited telegram\n',
    [`yeyo11/launches/${D}/discord.md@HEAD`]: '# Discord\n\n> **Approval:** x\n\nEdited discord\n',
    'yeyo11/claudio/.github/launch.yml@v0.8.2':
      'enabled: true\nbrand: personal\npublishing:\n  hashnode: approval\n  telegram: approval\n  discord: approval\nreddit:\n  subreddits: [ClaudeAI]\n',
  };
  const registry = await memoryRegistry();
  const launch = await drafted(registry);
  const { calls, publishers } = recorder();
  const ok = (channel: string) => async (input: unknown) => {
    calls.push({ channel, input });
    return { externalId: `${channel}-1`, url: `https://${channel}.example/1` };
  };
  publishers.hashnode = { publish: ok('hashnode') };
  publishers.telegram = { publish: ok('telegram') };
  publishers.discord = { publish: ok('discord') };
  const result = await publishLaunch(launch, brand, { github: new FakeGitHub('merged', files), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(true) });

  assert.equal(result.state, 'published');
  const input = (channel: string) => calls.find((c) => c.channel === channel)!.input;
  assert.deepEqual(input('hashnode'), {
    title: 'Edited title',
    markdown: 'Edited body.',
    tags: ['claude', 'typescript'],
    canonicalUrl: 'https://josegarrido.dev/en/claudio/',
    coverImageUrl: 'https://josegarrido.dev/launches/claudio/v0.8.2/og.png',
  });
  assert.deepEqual(input('telegram'), { text: 'Edited telegram', imageUrl: 'https://josegarrido.dev/launches/claudio/v0.8.2/og.jpg' });
  assert.deepEqual(input('discord'), {
    content: 'Edited discord',
    embed: {
      title: 'Edited title',
      url: 'https://josegarrido.dev/en/claudio/',
      description: 'Edited description',
      imageUrl: 'https://josegarrido.dev/launches/claudio/v0.8.2/og.png',
    },
  });
  assert.deepEqual((await registry.posts(launch.id)).map((p) => p.channel).sort(), ['blog', 'bluesky', 'devto', 'discord', 'hashnode', 'instagram', 'mastodon', 'telegram']);

  await publishLaunch((await registry.get(launch.id))!, brand, { github: new FakeGitHub('merged', files), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(true) });
  assert.equal(calls.length, 7, 'a second round publishes nothing again');
});

test('when the article goes live Google is asked to read the sitemap, once, and a failure there holds nothing back', async () => {
  const registry = await memoryRegistry();
  const launch = await drafted(registry);
  const { calls, publishers } = recorder();
  const submitted: string[] = [];
  const search = {
    pageMetrics: async () => ({}),
    submitSitemap: async (url: string) => {
      submitted.push(url);
      throw new Error('Search Console: submit the sitemap: 503');
    },
  };
  const deps = { github: new FakeGitHub('merged'), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(true), search };

  const result = await publishLaunch(launch, brand, deps);
  assert.equal(result.state, 'published');
  assert.equal(calls.length, 4);
  assert.deepEqual(submitted, ['https://josegarrido.dev/sitemap-index.xml']);

  await publishLaunch((await registry.get(launch.id))!, brand, deps);
  assert.equal(submitted.length, 1, 'the article was already recorded: not asked again');
});

test('the blog records one article per language, each at its own URL', async () => {
  const files = {
    ...merged,
    [`yeyo11/launches/${D}/pack.json@HEAD`]: JSON.stringify({
      ...pack,
      article: { ...pack.article, es: { slug: 'claudio-como-servicio', title: 't', description: 'd', markdown: 'm' } },
    }),
  };
  const registry = await memoryRegistry();
  const launch = await drafted(registry);
  const { publishers } = recorder();
  const deps = { github: new FakeGitHub('merged', files), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(true) };
  await publishLaunch(launch, brand, deps);
  await registry.setStatus(launch.id, 'drafted', launch.detail);
  await publishLaunch((await registry.get(launch.id))!, brand, deps);
  assert.deepEqual(
    (await registry.posts(launch.id, { channel: 'blog' })).map((p) => [p.kind, p.url, p.externalId]),
    [
      ['article:en', 'https://josegarrido.dev/en/claudio/', 'claudio'],
      ['article:es', 'https://josegarrido.dev/es/claudio-como-servicio/', 'claudio-como-servicio'],
    ],
  );
});

test('a post deleted after the launch is never published again, even with the launch drafted again', async () => {
  const registry = await memoryRegistry();
  const launch = await drafted(registry);
  const { calls, publishers } = recorder();
  const deps = { github: new FakeGitHub('merged'), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(true) };
  assert.equal((await publishLaunch(launch, brand, deps)).state, 'published');
  const [mastodon] = await registry.posts(launch.id, { channel: 'mastodon' });
  await deletePost(mastodon!.id, { registry, editors: async () => ({ mastodon: { edit: async () => {}, delete: async () => {} } }) });

  const before = calls.length;
  await registry.setStatus(launch.id, 'drafted', launch.detail);
  assert.equal((await publishLaunch((await registry.get(launch.id))!, brand, deps)).state, 'published');
  assert.equal(calls.length, before, 'deleting never re-enables publishing the same piece');
  assert.equal((await registry.post(mastodon!.id))!.status, 'deleted');
});

const T = new Date('2026-11-03T09:00:00.000Z');
const hours = (n: number) => new Date(T.getTime() + n * 3600_000);

test('a scheduled channel waits for its time, never holds the others back, and goes out once in its own row', async () => {
  const registry = await memoryRegistry();
  const launch = await drafted(registry);
  const { calls, publishers } = recorder();
  const [waiting] = await scheduleLaunch(registry, launch.id, { bluesky: hours(2) }, { now: T });
  assert.deepEqual([waiting?.status, waiting?.scheduledAt, waiting?.externalId], ['scheduled', hours(2).toISOString(), null]);

  let clock = T;
  const deps = { github: new FakeGitHub('merged'), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(true), now: () => clock };
  const first = await publishLaunch(launch, brand, deps);
  assert.equal(first.state, 'partial');
  assert.deepEqual(first.state === 'partial' && first.scheduled, [{ channel: 'bluesky', at: hours(2).toISOString() }]);
  assert.deepEqual(calls.map((c) => c.channel), ['devto', 'mastodon', 'instagram'], 'the other channels go out at once');
  assert.equal((await registry.get(launch.id))!.status, 'drafted', 'the launch waits for its scheduled piece');

  clock = hours(1);
  await publishLaunch((await registry.get(launch.id))!, brand, deps);
  assert.equal(calls.length, 3, 'not before its time');

  clock = hours(2);
  const due = await publishLaunch((await registry.get(launch.id))!, brand, deps);
  assert.equal(due.state, 'published');
  assert.deepEqual(calls.map((c) => c.channel), ['devto', 'mastodon', 'instagram', 'bluesky']);
  const [out] = await registry.posts(launch.id, { channel: 'bluesky' });
  assert.deepEqual([out?.id, out?.status, out?.externalId, out?.scheduledAt], [waiting?.id, 'live', 'bluesky-1', hours(2).toISOString()], 'the same row, now live, keeping its slot');

  await registry.setStatus(launch.id, 'drafted', launch.detail);
  await publishLaunch((await registry.get(launch.id))!, brand, deps);
  assert.equal(calls.length, 4, 'a launch happens once');
});

test('a slot missed while the machine was off goes out on the next run', async () => {
  const registry = await memoryRegistry();
  const launch = await drafted(registry);
  const { calls, publishers } = recorder();
  await scheduleLaunch(registry, launch.id, { mastodon: hours(1), bluesky: hours(30) }, { now: T });
  // Off from before the first slot until three days later
  const result = await publishLaunch(launch, brand, { github: new FakeGitHub('merged'), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(true), now: () => hours(72) });
  assert.equal(result.state, 'published', 'overdue is sent, not dropped');
  assert.equal(calls.filter((c) => c.channel === 'mastodon' || c.channel === 'bluesky').length, 2);
});

test('a scheduled piece is moved and cancelled; a cancelled channel is not published, and scheduling it again brings it back', async () => {
  const registry = await memoryRegistry();
  const launch = await drafted(registry);
  const { calls, publishers } = recorder();
  const [bluesky, mastodon] = await scheduleLaunch(registry, launch.id, { bluesky: hours(5), mastodon: hours(5) }, { now: T });
  const deps = { github: new FakeGitHub('open'), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(true), now: () => T };

  // Moved to a time past: due at once
  assert.equal((await reschedulePost(registry, bluesky!.id, hours(-1), { now: T })).scheduledAt, hours(-1).toISOString());
  await cancelScheduledPost(registry, mastodon!.id);
  await assert.rejects(cancelScheduledPost(registry, mastodon!.id), (e: unknown) => e instanceof ScheduleRefused && e.reason === 'not_found');

  // Scheduled again (which forgets the cancel), then cancelled again
  await scheduleLaunch(registry, launch.id, { mastodon: hours(6) }, { now: T });
  assert.equal(await registry.cursor(`publish-cancelled:${launch.id}:mastodon`), undefined);
  const again = (await registry.posts(launch.id, { channel: 'mastodon' }))[0]!;
  await cancelScheduledPost(registry, again.id);
  assert.equal((await publishLaunch(launch, brand, deps)).state, 'waiting', 'nothing goes out before the merge, scheduled or not');

  const result = await publishLaunch(launch, brand, { ...deps, github: new FakeGitHub('merged') });
  assert.equal(result.state, 'published');
  assert.deepEqual(calls.map((c) => c.channel).sort(), ['bluesky', 'devto', 'instagram'], 'the cancelled channel is left out');
});

test('a schedule is refused for a channel out already, one Shipcast does not publish, one off in launch.yml, or a launch done', async () => {
  const registry = await memoryRegistry();
  const launch = await drafted(registry);
  const refused = (reason: string) => (e: unknown) => e instanceof ScheduleRefused && e.reason === reason;
  await registry.recordPost({ launchId: launch.id, channel: 'devto', externalId: '1', url: 'https://dev.to/1' });
  await assert.rejects(scheduleLaunch(registry, launch.id, { devto: hours(1) }, { now: T }), refused('refused'));
  await assert.rejects(scheduleLaunch(registry, launch.id, { reddit: hours(1) }, { now: T }), refused('invalid'));
  await assert.rejects(scheduleLaunch(registry, launch.id, { bluesky: hours(24 * 61) }, { now: T }), refused('invalid'));
  const parsed = parseLaunchConfig('enabled: true\nbrand: personal\npublishing:\n  mastodon: off\n');
  assert.ok(parsed.ok);
  await assert.rejects(scheduleLaunch(registry, launch.id, { mastodon: hours(1) }, { now: T, config: parsed.value }), refused('refused'));
  await assert.rejects(scheduleLaunch(registry, 999, { bluesky: hours(1) }, { now: T }), refused('not_found'));

  // Scheduling twice moves the one row; the uniqueness of the piece holds
  await scheduleLaunch(registry, launch.id, { bluesky: hours(1) }, { now: T });
  await scheduleLaunch(registry, launch.id, { bluesky: hours(3) }, { now: T });
  const rows = await registry.posts(launch.id, { channel: 'bluesky' });
  assert.deepEqual(rows.map((p) => [p.status, p.scheduledAt]), [['scheduled', hours(3).toISOString()]]);

  await registry.setStatus(launch.id, 'published', launch.detail);
  await assert.rejects(scheduleLaunch(registry, launch.id, { mastodon: hours(1) }, { now: T }), refused('refused'));
});

test('the newsletter’s scheduled row goes once its issues are out', async () => {
  const withNewsletter = Brand.parse({
    id: 'personal',
    displayName: 'Me',
    site: 'https://josegarrido.dev',
    github: 'yeyo11',
    newsletter: { sender: { name: 'Me', email: 'hola@josegarrido.dev' }, lists: { en: 3 } },
  });
  const files = {
    ...merged,
    [`yeyo11/launches/${D}/pack.json@HEAD`]: JSON.stringify({ ...pack, newsletter: { en: { subject: 's', previewText: 'p', markdown: 'b' } } }),
    'yeyo11/claudio/.github/launch.yml@v0.8.2': 'enabled: true\nbrand: personal\npublishing:\n  newsletter: approval\n',
  };
  const registry = await memoryRegistry();
  const launch = await drafted(registry);
  await scheduleLaunch(registry, launch.id, { newsletter: hours(1) }, { now: T });
  const publishers: Publishers = { newsletter: { subscribers: async () => 5, send: async () => ({ externalId: '77', url: 'https://app.brevo.com/r/77' }) } };
  const deps = { github: new FakeGitHub('merged', files), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(true) };
  assert.equal((await publishLaunch(launch, withNewsletter, { ...deps, now: () => T })).state, 'partial');
  assert.equal((await publishLaunch(launch, withNewsletter, { ...deps, now: () => hours(2) })).state, 'published');
  assert.deepEqual((await registry.posts(launch.id, { channel: 'newsletter' })).map((p) => [p.kind, p.status]), [['issue:en', 'live']]);
});

test('GitHub Discussions, Threads and LinkedIn are published once with the edited drafts', async () => {
  const files = {
    ...merged,
    [`yeyo11/launches/${D}/pack.json@HEAD`]: JSON.stringify({
      ...pack,
      githubDiscussions: { title: 'AI title', body: 'AI body' },
      threads: { text: 'AI threads' },
      linkedin: { text: 'AI linkedin' },
    }),
    [`yeyo11/launches/${D}/github-discussion.md@HEAD`]: '# GitHub Discussions\n\n> **Approval:** x\n\nTitle: Edited discussion\n\n---\n\nEdited **body**\n',
    [`yeyo11/launches/${D}/threads.md@HEAD`]: '# Threads\n\n> **Approval:** x\n\nEdited threads\n',
    [`yeyo11/launches/${D}/linkedin.md@HEAD`]: '# LinkedIn\n\n> **Approval:** x\n\nEdited linkedin\n',
    'yeyo11/claudio/.github/launch.yml@v0.8.2': 'enabled: true\nbrand: personal\npublishing:\n  threads: approval\n  linkedin: approval\nreddit:\n  subreddits: [ClaudeAI]\n',
  };
  const registry = await memoryRegistry();
  const launch = await drafted(registry);
  const { calls, publishers } = recorder();
  const ok = (channel: string) => async (input: unknown) => {
    calls.push({ channel, input });
    return { externalId: `${channel}-1`, url: `https://${channel}.example/1` };
  };
  publishers.githubDiscussions = { publish: ok('githubDiscussions') };
  publishers.threads = { publish: ok('threads') };
  publishers.linkedin = { publish: ok('linkedin') };
  const deps = { github: new FakeGitHub('merged', files), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(true) };
  const result = await publishLaunch(launch, brand, deps);

  assert.equal(result.state, 'published');
  const input = (channel: string) => calls.find((c) => c.channel === channel)!.input;
  assert.deepEqual(input('githubDiscussions'), { repo: 'yeyo11/claudio', title: 'Edited discussion', body: 'Edited **body**' }, 'the discussion goes in the launched repo, on by default');
  assert.deepEqual(input('threads'), { text: 'Edited threads', imageUrl: 'https://josegarrido.dev/launches/claudio/v0.8.2/og.jpg' });
  assert.deepEqual(input('linkedin'), {
    text: 'Edited linkedin',
    article: {
      url: 'https://josegarrido.dev/en/claudio/?ref=linkedin',
      title: 'Edited title',
      description: 'Edited description',
      thumbnail: { bytes: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: 'image/jpeg' },
    },
  });
  const channels: string[] = (await registry.posts(launch.id)).map((p) => p.channel);
  for (const c of ['githubDiscussions', 'threads', 'linkedin']) assert.ok(channels.includes(c), c);

  const before = calls.length;
  await publishLaunch((await registry.get(launch.id))!, brand, deps);
  assert.equal(calls.length, before, 'a second round publishes nothing again');
});

test('an article written in the app opens no discussion: it belongs to no project repo', async () => {
  const registry = await memoryRegistry();
  const { launch: claimed } = await registry.claim({ repo: 'yeyo11/launches', ref: 'article:notes', trigger: 'article', kind: 'launch', brand: 'personal' });
  const launch = await registry.setStatus(claimed.id, 'drafted', 'direct:abc');
  const files = {
    'yeyo11/launches/articles/notes/pack.json@HEAD': JSON.stringify({ ...pack, githubDiscussions: { title: 't', body: 'b' } }),
    'yeyo11/launches/articles/notes/launch.yml@HEAD': 'enabled: true\nbrand: personal\npublishing:\n  devto: off\n  bluesky: off\n  mastodon: off\n  instagram: off\n  githubDiscussions: approval\n',
    'yeyo11/launches/src/content/posts/en/claudio.md@HEAD': merged['yeyo11/launches/src/content/posts/en/claudio.md@HEAD']!,
  };
  const { calls, publishers } = recorder();
  publishers.githubDiscussions = { publish: async () => assert.fail('no discussion for an article') };
  const result = await publishLaunch(launch, brand, { github: new FakeGitHub('merged', files), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(true) });
  assert.equal(result.state, 'published');
  assert.equal(calls.length, 0);
});
