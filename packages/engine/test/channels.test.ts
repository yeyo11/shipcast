import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Brand, channelDefinition, CHANNELS, ContentPack, draftFile, draftOf, LaunchConfig } from '@shipcast/schema';
import {
  ADAPT_TARGETS,
  CAPABILITIES,
  COMMENT_CHANNELS,
  DEFAULT_PROMPTS,
  editDraft,
  IDEMPOTENT_CHANNELS,
  launchDir,
  launchReplyContext,
  METRIC_FAMILIES,
  PUBLISHED_BY_ENGINE,
  readReview,
  renderDrafts,
  REPLY_LIMITS,
  ReviewError,
  SCHEDULABLE_CHANNELS,
  type Launch,
  type ReviewGitHub,
} from '../src/index.ts';
import { memoryRegistry } from '../src/testing.ts';

/*
 * The engine's per-channel tables are the channel definitions' (packages/schema/src/channels): these
 * check what each derives, and the drift the tables written by hand had (docs/plans/performance-refactor.md).
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
const launch = (await (await memoryRegistry()).launches.claim({ repo: 'yeyo11/claudio', ref: 'v0.9.0', trigger: 'release', kind: 'launch', brand: 'personal' })).launch;
const article = { title: 'claudio', description: 'Claude Code as a service.', markdown: 'Body.' };
const pack = ContentPack.parse({
  schemaVersion: 1,
  kind: 'launch',
  project: { name: 'claudio', repo: 'https://github.com/yeyo11/claudio' },
  analysis: { summary: 'S', implemented: ['A'], planned: [], documentedOnly: [], limitations: [] },
  article: { tags: [], en: { slug: 'claudio', ...article }, es: { slug: 'claudio-es', ...article } },
  devto: { tags: ['ai'] },
  hashnode: { tags: ['ai'] },
  bluesky: { lang: 'en', text: 'Bluesky post' },
  mastodon: { lang: 'en', text: 'Mastodon post' },
  instagram: { caption: 'Caption.', summary: 'S', slides: [{ title: 'a', text: 'b' }, { title: 'c', text: 'd' }] },
  reddit: [{ subreddit: 'ClaudeAI', title: 'I built claudio', body: 'What and why.' }],
  linkedin: { text: 'LinkedIn post' },
  newsletter: { en: { subject: 'Out', previewText: 'P', markdown: 'Note.' }, es: { subject: 'Sale', previewText: 'P', markdown: 'Nota.' } },
  telegram: { text: 'Telegram post' },
  discord: { text: 'Discord post' },
  githubDiscussions: { title: 'claudio 0.9', body: 'What shipped.' },
  threads: { text: 'Threads post' },
  youtube: {
    short: { title: 'claudio in a minute', description: 'What it shows.', tags: [], lang: 'en', scenes: [{ kind: 'card', subtitle: 'a', seconds: 5 }, { kind: 'cover', subtitle: 'b', seconds: 5 }] },
    video: { title: 'claudio, a walk-through', description: 'What it shows.', tags: [], lang: 'en', scenes: [{ kind: 'card', subtitle: 'a', seconds: 30 }, { kind: 'cover', subtitle: 'b', seconds: 30 }] },
  },
});
const everything = LaunchConfig.parse({
  enabled: true,
  brand: 'personal',
  publishing: Object.fromEntries(CHANNELS.map((c) => [c, 'approval'])),
  reddit: { subreddits: ['ClaudeAI'] },
});

test('every draft file renderDrafts writes is matched back to its channel and headed with its title', () => {
  const dir = launchDir(launch);
  const drafts = renderDrafts(pack, launch, everything, brand, new Date('2026-10-28')).filter((f) => f.path.startsWith(`${dir}/`) && f.path.endsWith('.md') && !f.path.endsWith('release-notes.md'));
  const channels = new Set<string>();
  for (const file of drafts) {
    const of = draftOf(file.path);
    assert.ok(of, `${file.path} is a channel's`);
    channels.add(of.channel);
    // A subreddit's file name is lowercased, its heading keeps the subreddit as written
    const heading = 'content' in file ? file.content.split('\n')[0]!.toLowerCase() : '';
    assert.equal(heading, `# ${draftFile(of.channel, of.part).title}`.toLowerCase(), `${file.path} is headed with its title`);
  }
  assert.deepEqual([...channels].sort(), CHANNELS.filter((c) => c !== 'blog').sort(), 'every channel but the blog has its draft');
});

test("the review labels every draft with its heading, GitHub Discussions' and a subreddit's included", async () => {
  const dir = launchDir(launch);
  const files = renderDrafts(pack, launch, everything, brand, new Date('2026-10-28'));
  const github: ReviewGitHub = {
    pullRequest: async () => ({ number: 7, url: 'u', state: 'open', branch: 'launch/x', title: 't' }),
    pullRequestFiles: async () => files.map((f) => f.path),
    fileAt: async (_repo, path) => {
      const file = files.find((f) => f.path === path);
      return file && 'content' in file ? file.content : undefined;
    },
    updateFile: async () => {},
    mergePullRequest: async () => ({ sha: 'x' }),
  };
  const withPr = { ...launch, detail: 'https://github.com/yeyo11/launches/pull/7' } as Launch;
  const review = await readReview(withPr, { github, launchesRepo: 'yeyo11/launches' });
  const label = (name: string) => review?.drafts.find((d) => d.path === `${dir}/${name}`)?.label;
  assert.equal(label('github-discussion.md'), 'GitHub Discussions');
  assert.equal(label('reddit-claudeai.md'), 'Reddit, r/claudeai');
  assert.equal(label('newsletter-es.md'), 'Newsletter (es)');
  assert.equal(label('threads.md'), 'Threads');
  assert.equal(review?.drafts.find((d) => d.path === `${dir}/release-notes.md`), undefined);

  // The cap is found through the definition's matcher: a Threads draft past 500 is refused
  const tooLong = `# Threads\n\n> **Approval:** x\n\n${'a'.repeat(501)}`;
  await assert.rejects(editDraft(withPr, `${dir}/threads.md`, tooLong, { github, launchesRepo: 'yeyo11/launches' }), ReviewError);
});

test('the engine channels, the schedulable and the idempotent ones come from the definitions', () => {
  assert.deepEqual([...PUBLISHED_BY_ENGINE], CHANNELS.filter((c) => c !== 'blog'));
  assert.ok(!SCHEDULABLE_CHANNELS.includes('reddit') && !SCHEDULABLE_CHANNELS.includes('blog'));
  assert.deepEqual([...IDEMPOTENT_CHANNELS].sort(), ['mastodon', 'reddit']);
  for (const channel of CHANNELS) {
    assert.equal(CAPABILITIES[channel].note, channelDefinition(channel).edit.note);
    assert.equal(DEFAULT_PROMPTS[`channel.${channel}`], channelDefinition(channel).brief, `${channel} has its brief`);
  }
});

test('Threads and GitHub Discussions are measured, adapted to and answered like the others', async () => {
  assert.deepEqual(METRIC_FAMILIES.threads?.reactions, ['likes']);
  assert.deepEqual(METRIC_FAMILIES.githubDiscussions?.comments, ['comments']);
  assert.ok(METRIC_FAMILIES.github && METRIC_FAMILIES.search, 'the sources that are not channels stay');
  assert.equal(ADAPT_TARGETS.threads.name, 'Threads');
  assert.equal(ADAPT_TARGETS.githubDiscussions.name, 'GitHub Discussions');
  assert.equal(ADAPT_TARGETS.newsletter.name, 'the newsletter');
  for (const channel of COMMENT_CHANNELS) assert.ok(REPLY_LIMITS[channel] > 0);

  const context = await launchReplyContext({
    github: { fileAt: async () => JSON.stringify(pack) },
    launchesRepo: 'yeyo11/launches',
    checkout: async () => ({ hostPath: '/w' }),
  })(launch);
  assert.deepEqual(context.postText, {
    devto: 'claudio\n\nClaude Code as a service.',
    bluesky: 'Bluesky post',
    mastodon: 'Mastodon post',
    instagram: 'Caption.',
    githubDiscussions: 'claudio 0.9\n\nWhat shipped.',
    threads: 'Threads post',
    youtube: 'claudio, a walk-through\n\nWhat it shows.',
  });
});
