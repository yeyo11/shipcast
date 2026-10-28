import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CHANNELS, channelName, draftFile } from '@shipcast/schema/channels';
import { ADAPT_NETWORKS, channelOfDraft } from '../src/components/assistant/protocol.ts';
import { CHANNEL_SLOT } from '../src/components/charts/palette.ts';
import { groupOf } from '../src/server/network-groups.ts';
import { draftPrefill, networkName } from '../src/server/pieces.ts';
import { CHANNEL_NAMES, channelIcon } from '../src/server/view.ts';

/*
 * The app's per-channel tables are the channel definitions' (packages/schema/src/channels): one name
 * and one icon per channel everywhere, and every draft file found by its channel's own matcher.
 */

const DESIGN = fileURLToPath(new URL('../../../design/', import.meta.url));
const D = 'launches/claudio/v1';
const draft = (title: string, body: string) => `# ${title}\n\n> **Approval:** published when this pull request is merged.\n\n${body}\n`;

test('every channel has one name and an icon that exists, Threads included', () => {
  for (const channel of CHANNELS) {
    assert.equal(CHANNEL_NAMES[channel], channelName(channel));
    assert.equal(networkName(channel), channelName(channel));
    const icon = channelIcon(channel);
    assert.ok(icon && existsSync(`${DESIGN}${icon}`), `${channel}'s icon is in the design system`);
  }
  assert.equal(channelIcon('threads'), '/icons/threads.svg');
  assert.equal(networkName('brevo'), 'Newsletter', 'an account names the channel it publishes');
});

test('every channel draft is found, including Threads, LinkedIn, GitHub Discussions and the newsletter', () => {
  for (const channel of CHANNELS.filter((c) => c !== 'blog')) {
    const part = channel === 'newsletter' ? 'es' : channel === 'reddit' ? 'rust' : '';
    assert.equal(channelOfDraft(`${D}/${draftFile(channel, part).name}`), channel);
  }
  assert.equal(channelOfDraft(`${D}/release-notes.md`), undefined);
});

test("the edit form starts from GitHub Discussions', a subreddit's and the newsletter's drafts, the title in the title field", () => {
  const drafts = [
    { path: `${D}/github-discussion.md`, content: draft('GitHub Discussions', 'Title: claudio 1.0\n\n---\n\nWhat shipped.') },
    { path: `${D}/reddit-rust.md`, content: draft('Reddit, r/rust', 'Title: I built claudio\n\n---\n\nWhy.') },
    { path: `${D}/reddit-node.md`, content: draft('Reddit, r/node', 'Title: For Node\n\n---\n\nHow.') },
    { path: `${D}/newsletter-en.md`, content: draft('Newsletter (en)', 'Subject: Out now\nPreview: P\n\nThe note.') },
  ];
  assert.deepEqual(draftPrefill(drafts, { channel: 'githubDiscussions', kind: 'post' }), { text: 'What shipped.', title: 'claudio 1.0' });
  assert.deepEqual(draftPrefill(drafts, { channel: 'reddit', kind: 'post:node' }), { text: 'How.', title: 'For Node' });
  assert.deepEqual(draftPrefill(drafts, { channel: 'newsletter', kind: 'post' }), { text: 'The note.', title: 'Out now' });
});

test('Adapt offers every channel that says what its post may hold, by its one name', () => {
  const ids = ADAPT_NETWORKS.map((n) => n.id);
  assert.ok(ids.includes('threads') && ids.includes('githubDiscussions'));
  assert.ok(!ids.includes('blog'));
  for (const n of ADAPT_NETWORKS) assert.equal(n.name, channelName(n.id));
});

test('the Channels page groups and the chart slots come from the definitions', () => {
  assert.equal(groupOf({ channel: 'newsletter' }), 'blog');
  assert.equal(groupOf({ channel: 'devto' }), 'blog');
  assert.equal(groupOf({ channel: 'threads' }), 'social');
  assert.equal(CHANNEL_SLOT.devto, 'ink');
  assert.equal(CHANNEL_SLOT.github, 3);
  assert.equal(CHANNEL_SLOT.threads, undefined, 'past the seven slots: it takes the first free one');
});
