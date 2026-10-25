import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorError } from '@shipcast/connectors';
import { Brand } from '@shipcast/schema';
import { draftBody, publishLaunch, Registry, type EventsPage, type GitHubSource, type Publishers } from '../src/index.ts';

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

function drafted(registry: Registry) {
  const { launch } = registry.claim({ repo: 'yeyo11/claudio', ref: 'v0.8.2', trigger: 'release', kind: 'launch', brand: 'personal' });
  return registry.setStatus(launch.id, 'drafted', 'https://github.com/yeyo11/launches/pull/3');
}

test('a draft body is what follows its mode line', () => {
  assert.equal(draftBody('# Bluesky\n\n> **Approval:** published when merged.\n\nThe post.\n'), 'The post.');
});

test('nothing is published while the drafts pull request is open, nor before the site is live', async () => {
  const registry = new Registry(':memory:');
  const launch = drafted(registry);
  const { calls, publishers } = recorder();
  const open = await publishLaunch(launch, brand, { github: new FakeGitHub('open'), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(true) });
  assert.equal(open.state, 'waiting');
  const notLive = await publishLaunch(launch, brand, { github: new FakeGitHub('merged'), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(false) });
  assert.deepEqual(notLive.state === 'waiting' && notLive.reason, 'https://josegarrido.dev/en/claudio/ is not live yet');
  assert.equal(calls.length, 0);
});

test('a drafts pull request closed without merging skips the launch', async () => {
  const registry = new Registry(':memory:');
  const result = await publishLaunch(drafted(registry), brand, { github: new FakeGitHub('closed'), registry, launchesRepo: 'yeyo11/launches', publishers: {}, fetch: site(true) });
  assert.equal(result.state, 'skipped');
  assert.match(result.launch.detail ?? '', /closed without merging/);
});

test('after the merge every approval channel is published with the edited texts, once', async () => {
  const registry = new Registry(':memory:');
  const launch = drafted(registry);
  const { calls, publishers } = recorder();
  const deps = { github: new FakeGitHub('merged'), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(true) };

  const result = await publishLaunch(launch, brand, deps);
  assert.equal(result.state, 'published');
  assert.deepEqual(calls.map((c) => c.channel), ['devto', 'bluesky', 'mastodon', 'instagram'], 'Reddit is manual: never posted');

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

  assert.equal(registry.get(launch.id)!.status, 'published');
  assert.deepEqual(registry.posts(launch.id).map((p) => p.channel).sort(), ['blog', 'bluesky', 'devto', 'instagram', 'mastodon']);

  await publishLaunch(registry.get(launch.id)!, brand, deps);
  assert.equal(calls.length, 4, 'a second round publishes nothing again');
});

test('a temporary failure leaves the launch partial and is retried; a permanent one is recorded and not retried', async () => {
  const registry = new Registry(':memory:');
  const launch = drafted(registry);
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

  const second = await publishLaunch(registry.get(launch.id)!, brand, deps);
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
  const registry = new Registry(':memory:');
  const launch = drafted(registry);
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
  assert.equal(registry.posts(launch.id).find((p) => p.channel === 'newsletter')?.externalId, '901');

  await publishLaunch(registry.get(launch.id)!, withNewsletter, { github: new FakeGitHub('merged', files), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(true) });
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
  const registry = new Registry(':memory:');
  const launch = drafted(registry);
  let reads = 0;
  const publishers: Publishers = { newsletter: { subscribers: async () => (reads++, 0), send: async () => assert.fail('nothing to send') } };
  const deps = { github: new FakeGitHub('merged', files), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(true) };
  const first = await publishLaunch(launch, withNewsletter, deps);
  assert.ok(first.state !== 'waiting' && first.state !== 'skipped');
  assert.match(first.state === 'published' || first.state === 'partial' ? first.problems.join() : '', /no subscribers yet in the en list/);
  await publishLaunch(registry.get(launch.id)!, withNewsletter, deps);
  assert.equal(reads, 1);
});

test('after the Instagram carousel, its story and the edited comment go out once; their failures never repost it', async () => {
  const registry = new Registry(':memory:');
  const launch = drafted(registry);
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
  assert.equal(registry.posts(launch.id).filter((p) => p.channel === 'instagram').length, 1);
});

test('Hashnode, Telegram and Discord are published with the edited drafts; Show HN and Product Hunt never are', async () => {
  const files = {
    ...merged,
    [`yeyo11/launches/${D}/pack.json@HEAD`]: JSON.stringify({
      ...pack,
      hashnode: { tags: ['ai'] },
      telegram: { text: 'AI telegram' },
      discord: { text: 'AI discord' },
      hackerNews: { title: 'Show HN: claudio', firstComment: 'c' },
      productHunt: { tagline: 't', description: 'd', firstComment: 'c' },
    }),
    [`yeyo11/launches/${D}/hashnode.md@HEAD`]: '# Hashnode\n\n> **Approval:** x\n\nRepublishes…\n\nTags: `claude`, `typescript`\n',
    [`yeyo11/launches/${D}/telegram.md@HEAD`]: '# Telegram\n\n> **Approval:** x\n\nEdited telegram\n',
    [`yeyo11/launches/${D}/discord.md@HEAD`]: '# Discord\n\n> **Approval:** x\n\nEdited discord\n',
    'yeyo11/claudio/.github/launch.yml@v0.8.2':
      'enabled: true\nbrand: personal\npublishing:\n  hashnode: approval\n  telegram: approval\n  discord: approval\n  hackerNews: manual\n  productHunt: manual\nreddit:\n  subreddits: [ClaudeAI]\n',
  };
  const registry = new Registry(':memory:');
  const launch = drafted(registry);
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
  assert.deepEqual(registry.posts(launch.id).map((p) => p.channel).sort(), ['blog', 'bluesky', 'devto', 'discord', 'hashnode', 'instagram', 'mastodon', 'telegram']);
  assert.ok(!calls.some((c) => c.channel === 'hackerNews' || c.channel === 'productHunt'));

  await publishLaunch(registry.get(launch.id)!, brand, { github: new FakeGitHub('merged', files), registry, launchesRepo: 'yeyo11/launches', publishers, fetch: site(true) });
  assert.equal(calls.length, 7, 'a second round publishes nothing again');
});

test('when the article goes live Google is asked to read the sitemap, once, and a failure there holds nothing back', async () => {
  const registry = new Registry(':memory:');
  const launch = drafted(registry);
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

  await publishLaunch(registry.get(launch.id)!, brand, deps);
  assert.equal(submitted.length, 1, 'the blog post was already recorded: not asked again');
});
