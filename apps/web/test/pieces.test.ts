import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAPABILITIES, METRIC_FAMILIES } from '@shipcast/engine';
import {
  accountRows,
  allowance,
  channelEntries,
  composedText,
  countdown,
  draftPrefill,
  groupState,
  isoToZonedInput,
  multiEditPlan,
  pieceRows,
  PRIMARY_METRIC,
  scheduleChips,
  signed,
  singleEditChanges,
  withStatus,
  zonedInputToIso,
  zonedLabel,
  type EditForm,
  type PieceInput,
} from '../src/server/pieces.ts';
import { groupChannels, type LaunchView } from '../src/server/view.ts';

const at = '2026-10-25T10:00:00.000Z';
let next = 1;
const post = (channel: string, extra: Partial<PieceInput> = {}): PieceInput => ({
  id: next++,
  channel,
  kind: 'post',
  accountId: null,
  externalId: `x${next}`,
  url: `https://${channel}.example/${next}`,
  status: 'live',
  scheduledAt: null,
  publishedAt: at,
  updatedAt: at,
  ...extra,
});

const rowsOf = (posts: PieceInput[], readings: Parameters<typeof pieceRows>[0]['readings'] = []) =>
  pieceRows({ posts, accounts: [{ id: 7, label: 'Mastodon (me)', identity: '@me@fosstodon.org', avatarUrl: null }], readings, capabilities: CAPABILITIES });

test('every primary metric is a number the stats section knows for that network', () => {
  for (const [channel, names] of Object.entries(PRIMARY_METRIC)) {
    const known = Object.values(METRIC_FAMILIES[channel] ?? {}).flat();
    for (const name of names) assert.ok(known.includes(name), `${channel}.${name}`);
  }
});

test('a piece row carries its account, its numbers over time and its lead number', () => {
  const p = post('mastodon', { accountId: 7 });
  const [row] = rowsOf(
    [p],
    [
      { postId: p.id, name: 'boosts', value: 1, takenAt: '2026-10-25T12:00:00.000Z' },
      { postId: p.id, name: 'favourites', value: 4, takenAt: '2026-10-25T12:00:00.000Z' },
      { postId: p.id, name: 'favourites', value: 9, takenAt: '2026-10-25T18:00:00.000Z' },
      { postId: p.id, name: 'favourites', value: 2, takenAt: '2026-10-25T06:00:00.000Z' },
    ],
  );
  assert.deepEqual(row?.account, { label: 'Mastodon (me)', handle: '@me@fosstodon.org', avatarUrl: null });
  assert.deepEqual(row?.metric, { name: 'favourites', value: 9, series: [2, 4, 9] }, 'favourites leads on Mastodon, readings oldest first');
  const fav = row?.numbers.find((n) => n.name === 'favourites');
  assert.deepEqual(fav, { name: 'favourites', value: 9, first: 2, series: [2, 4, 9], from: '2026-10-25T06:00:00.000Z', to: '2026-10-25T18:00:00.000Z' });
  assert.equal(rowsOf([post('telegram')])[0]?.metric, null, 'no readings, no number');
});

test('what a piece can do follows the capability map and its state, with the reason when it cannot', () => {
  const [mastodon, bluesky, instagram, story, devto, scheduled, deleted, noId, blog] = rowsOf([
    post('mastodon'),
    post('bluesky'),
    post('instagram'),
    post('instagram', { kind: 'story' }),
    post('devto'),
    post('telegram', { status: 'scheduled' }),
    post('discord', { status: 'deleted' }),
    post('telegram', { externalId: null }),
    post('blog', { kind: 'article:en', externalId: null }),
  ]);
  assert.equal(mastodon?.edit.allowed, true);
  assert.deepEqual(mastodon?.edit.fields, ['text', 'link', 'image']);
  assert.equal(mastodon?.remove.verb, 'Delete');
  assert.equal(bluesky?.edit.allowed, false);
  assert.equal(bluesky?.edit.reason, CAPABILITIES.bluesky.note);
  assert.equal(bluesky?.remove.allowed, true);
  assert.equal(instagram?.edit.allowed, false);
  assert.equal(instagram?.remove.allowed, false);
  assert.equal(instagram?.remove.reason, CAPABILITIES.instagram.note);
  assert.equal(story?.piece, 'story');
  assert.equal(devto?.remove.verb, 'Unpublish');
  assert.match(scheduled?.edit.reason ?? '', /Not out yet/);
  assert.match(deleted?.remove.reason ?? '', /Deleted already/);
  assert.match(noId?.edit.reason ?? '', /no id on Telegram/);
  assert.equal(blog?.edit.allowed, true, 'the blog needs no id: its article is a file');
  assert.equal(blog?.piece, 'EN');
  const gone = withStatus(mastodon!, 'deleted', at);
  assert.equal(gone.edit.allowed, false);
  assert.equal(gone.remove.allowed, false);
  assert.equal(withStatus(mastodon!, 'edited', at).edit.allowed, true);
});

test('the launch page has one entry per channel: what went out, what failed, what waits for a time', () => {
  const rows = rowsOf([
    post('blog', { kind: 'article:en' }),
    post('mastodon'),
    post('blog', { kind: 'article:es', status: 'deleted' }),
    post('instagram'),
    post('instagram', { kind: 'story' }),
    post('threads', { status: 'deleted' }),
  ]);
  const entries = channelEntries({
    rows,
    failures: [
      { channel: 'instagram', message: 'story refused' },
      { channel: 'bluesky', message: 'auth failed' },
    ],
    scheduling: [
      { channel: 'linkedin', scheduled: { id: 90, scheduledAt: '2026-10-28T08:30:00.000Z' } },
      { channel: 'telegram', scheduled: null },
    ],
    replies: { mastodon: 3 },
  });
  assert.deepEqual(
    entries.map((e) => [e.channel, e.pieces.length, e.mark, e.label, e.replies, e.failure ?? null, e.scheduling ? 'can schedule' : null]),
    [
      ['blog', 2, 'published', '1 of 2 published', 0, null, null],
      ['mastodon', 1, 'published', 'Published', 3, null, null],
      ['instagram', 2, 'failed', 'Failed', 0, 'story refused', null],
      ['threads', 1, 'off', 'Deleted', 0, null, null],
      ['bluesky', 0, 'failed', 'Failed', 0, 'auth failed', null],
      ['linkedin', 0, 'scheduled', 'Scheduled', 0, null, 'can schedule'],
      ['telegram', 0, 'off', 'Not out yet', 0, null, 'can schedule'],
    ],
  );
  assert.deepEqual(channelEntries({ rows: [], failures: [], scheduling: [] }), []);
  assert.deepEqual(groupState([{ status: 'failed' }, { status: 'live' }]), { label: 'Failed', tone: 'failed' });
  assert.deepEqual(groupState([{ status: 'deleted' }, { status: 'deleted' }]), { label: 'All deleted', tone: 'deleted' });
  assert.deepEqual(groupState([{ status: 'scheduled' }]), { label: 'Scheduled', tone: 'scheduled' });
  assert.deepEqual(groupState([{ status: 'edited' }]), { label: 'Edited', tone: 'published' });
});

test('the launch card groups a launch by channel: one row each, a failure kept open, replies counted', () => {
  const p = (id: number, channel: string, kind: string, status = 'live') => ({ id, channel, kind, url: `https://x/${id}`, publishedAt: at, status, scheduledAt: null });
  const launch: Pick<LaunchView, 'posts' | 'failures' | 'replies'> = {
    posts: [p(1, 'blog', 'article:en'), p(2, 'blog', 'article:es'), p(3, 'instagram', 'post'), p(4, 'instagram', 'story'), p(5, 'mastodon', 'post'), p(6, 'telegram', 'post', 'scheduled')],
    failures: [
      { channel: 'instagram', message: 'story: 500' },
      { channel: 'bluesky', message: 'auth failed' },
    ],
    replies: { mastodon: 4 },
  };
  const groups = groupChannels(launch);
  assert.deepEqual(
    groups.map((g) => [g.channel, g.pieces.map((x) => x.label), g.state.label, g.state.tone, g.expandable, g.hasFailure, g.replies]),
    [
      ['blog', ['EN', 'ES'], 'Published', 'published', true, false, 0],
      ['instagram', ['Post', 'story'], '2 of 2', 'failed', true, true, 0],
      ['mastodon', ['Post'], 'Published', 'published', false, false, 4],
      ['telegram', ['Post'], 'Scheduled', 'waiting', false, false, 0],
      ['bluesky', ['Post'], 'Failed', 'failed', false, true, 0],
    ],
  );
  assert.equal(groups.at(-1)?.pieces[0]?.failure, 'auth failed', 'a channel that failed before publishing has its failure as its only piece');
  assert.deepEqual(groupChannels({ posts: [p(7, 'devto', 'post', 'deleted')], failures: [], replies: {} })[0]?.state, { label: 'Deleted', tone: 'quiet' });
  assert.deepEqual(groupChannels({ posts: [], failures: [], replies: {} }), []);
});

test('an edit of several pieces says, per network, what each field becomes and what is left out', () => {
  const rows = rowsOf([post('mastodon'), post('telegram'), post('discord'), post('devto'), post('bluesky')]);
  const plan = multiEditPlan(rows, { link: 'https://josegarrido.dev/x', imageUrl: 'https://img/x.png' });
  assert.deepEqual(
    plan.map((p) => (p.ok ? [p.channel, 'ok', p.changes, p.dropped] : [p.channel, 'no', p.reason])),
    [
      ['mastodon', 'no', 'Mastodon replaces the whole text: write the text to go with the link'],
      ['telegram', 'no', 'Telegram replaces the whole text: write the text to go with the link'],
      ['discord', 'no', 'Discord replaces the whole text: write the text to go with the link'],
      ['devto', 'ok', ['the canonical URL', 'the cover'], []],
      ['bluesky', 'no', CAPABILITIES.bluesky.note],
    ],
  );
  const withText = multiEditPlan(rows, { text: 'New text', imageUrl: 'https://img/x.png' });
  assert.deepEqual(withText[2], { id: rows[2]!.id, channel: 'discord', piece: '', ok: true, changes: ['the message'], dropped: ['image'] });
  assert.equal(withText[3]?.ok && withText[3].warning, 'The text replaces the article’s whole body');
  assert.equal(multiEditPlan(rows, {})[0]?.ok, false, 'nothing asked, nothing to do');
  const telegramImage = multiEditPlan(rows, { imageUrl: 'https://img/x.png' })[1];
  assert.equal(telegramImage?.ok, false, 'a photo on Telegram needs its caption written again');
});

test('one piece’s edit sends what changed, and the text again where the network needs it whole', () => {
  const initial: EditForm = { text: 'Old', title: 'T', tags: '', link: '', imageUrl: '', imageAlt: '' };
  const fields = CAPABILITIES.telegram.fields;
  assert.equal(singleEditChanges('telegram', fields, initial, initial), undefined);
  assert.deepEqual(singleEditChanges('telegram', fields, { ...initial, link: ' https://x ' }, initial), { text: 'Old', link: 'https://x' });
  assert.deepEqual(singleEditChanges('telegram', fields, { ...initial, imageUrl: 'https://i', imageAlt: 'a cat' }, initial), { text: 'Old', imageUrl: 'https://i', imageAlt: 'a cat' });
  assert.deepEqual(singleEditChanges('devto', CAPABILITIES.devto.fields, { ...initial, title: 'New', tags: 'rust, cli,, ' }, initial), { title: 'New', tags: ['rust', 'cli'] });
  assert.deepEqual(singleEditChanges('bluesky', [], { ...initial, text: 'x' }, initial), undefined, 'a field the network does not take is never sent');
  assert.equal(composedText('mastodon', { text: 'Hello  ', link: 'https://x' }), 'Hello\n\nhttps://x');
  assert.equal(composedText('devto', { text: 'Body', link: 'https://x' }), 'Body');
  assert.equal(composedText('mastodon', { link: 'https://x' }), undefined);
});

test('the edit form starts from the merged draft, its front matter’s title in the title field', () => {
  const drafts = [
    { path: 'launches/claudio/v1/mastodon.md', content: 'Claudio 1.0 is out\n' },
    { path: 'src/content/posts/es/claudio.md', content: '---\ntitle: "Claudio, por fin"\ntags: [a]\n---\n\nEl cuerpo.\n' },
  ];
  assert.deepEqual(draftPrefill(drafts, { channel: 'mastodon', kind: 'post' }), { text: 'Claudio 1.0 is out', title: '' });
  assert.deepEqual(draftPrefill(drafts, { channel: 'blog', kind: 'article:es' }), { text: 'El cuerpo.', title: 'Claudio, por fin' });
  assert.deepEqual(draftPrefill(drafts, { channel: 'blog', kind: 'article:en' }), { text: '', title: '' });
  assert.deepEqual(draftPrefill([], { channel: 'bluesky', kind: 'post' }), { text: '', title: '' });
  // As a merged draft really is: the heading and approval note are the file's, not the post's
  const merged = [{ path: 'articles/rea/mastodon.md', content: '# Mastodon\n\n> **Approval:** published when this pull request is merged.\n\nI set up REA.\n\nhttps://josegarrido.dev/en/rea/\n' }];
  assert.deepEqual(draftPrefill(merged, { channel: 'mastodon', kind: 'post' }), { text: 'I set up REA.\n\nhttps://josegarrido.dev/en/rea/', title: '' });
});

test('recommended times become chips, best first, the past dropped; a countdown reads in words', () => {
  const now = new Date('2026-10-26T12:00:00.000Z');
  const chips = scheduleChips(
    [
      { at: '2026-10-26T08:00:00.000Z', local: 'Mon 2026-10-26 09:00', score: 1.4, reason: 'default' },
      { at: '2026-10-27T16:00:00.000Z', local: 'Tue 2026-10-27 17:00', score: 1.5, reason: 'weekdays 15–19' },
      { at: '2026-10-28T16:00:00.000Z', local: 'Wed 2026-10-28 17:00', score: 1.2, reason: 'weekdays 15–19' },
    ],
    now,
  );
  assert.deepEqual(
    chips.map((c) => [c.label, c.best]),
    [
      ['Tue 17:00', true],
      ['Wed 17:00', false],
    ],
  );
  assert.match(chips[0]!.title, /^Tue 2026-10-27 17:00: weekdays 15–19 \(expected 1\.5× a typical post\)$/);
  assert.equal(countdown('2026-10-26T11:00:00.000Z', now), 'due now: it goes out on the next run');
  assert.equal(countdown('2026-10-26T12:40:00.000Z', now), 'in 40 min');
  assert.equal(countdown('2026-10-26T15:05:00.000Z', now), 'in 3 h 5 min');
  assert.equal(countdown('2026-10-29T14:00:00.000Z', now), 'in 3 days 2 h');
  assert.equal(countdown('nope', now), '');
});

test('times are read and written on the owner’s clock, across the end of summer time', () => {
  // Madrid left summer time at 03:00 on 2026-10-25: +02:00 before, +01:00 after
  assert.equal(zonedInputToIso('2026-10-24T17:00', 'Europe/Madrid'), '2026-10-24T15:00:00.000Z');
  assert.equal(zonedInputToIso('2026-10-27T17:00', 'Europe/Madrid'), '2026-10-27T16:00:00.000Z');
  assert.equal(zonedInputToIso('2026-10-27T17:00', 'Asia/Kolkata'), '2026-10-27T11:30:00.000Z');
  assert.equal(zonedInputToIso('27/10/2026 17:00', 'Europe/Madrid'), undefined);
  assert.equal(isoToZonedInput('2026-10-27T16:00:00.000Z', 'Europe/Madrid'), '2026-10-27T17:00');
  assert.equal(isoToZonedInput('2026-10-24T15:00:00.000Z', 'Europe/Madrid'), '2026-10-24T17:00');
  assert.equal(zonedLabel('2026-10-27T16:00:00.000Z', 'Europe/Madrid'), 'Tue 27 Oct, 17:00');
});

test('each account the launch went out with shows its followers from the day before the launch', () => {
  const accounts = [
    { id: 1, network: 'mastodon', label: 'Mastodon', identity: '@me@fosstodon.org', avatarUrl: null },
    { id: 2, network: 'bluesky', label: 'Bluesky', identity: 'me.bsky.social', avatarUrl: 'https://cdn/a.jpg' },
    { id: 3, network: 'devto', label: 'dev.to', identity: 'me', avatarUrl: null },
  ];
  const rows = accountRows({
    posts: [
      { channel: 'mastodon', accountId: 1 },
      { channel: 'bluesky', accountId: 2 },
      { channel: 'blog', accountId: null },
    ],
    accounts,
    snapshots: [
      { accountId: 1, day: '2026-10-20', followers: 90 },
      { accountId: 1, day: '2026-10-23', followers: 100 },
      { accountId: 1, day: '2026-10-24', followers: 112 },
      { accountId: 1, day: '2026-10-26', followers: 130 },
      { accountId: 2, day: '2026-10-25', followers: null },
      { accountId: 3, day: '2026-10-25', followers: 5 },
    ],
    launchedAt: '2026-10-24T09:00:00.000Z',
  });
  assert.deepEqual(rows, [
    { id: 1, network: 'mastodon', label: 'Mastodon', handle: '@me@fosstodon.org', avatarUrl: null, channels: ['mastodon'], followers: { before: 100, now: 130, change: 30, series: [100, 112, 130], from: '2026-10-23', to: '2026-10-26' } },
    { id: 2, network: 'bluesky', label: 'Bluesky', handle: 'me.bsky.social', avatarUrl: '/avatars/2', channels: ['bluesky'], followers: null },
  ]);
  assert.equal(signed(30), '+30');
  assert.equal(signed(-1200), '−1,200');
  assert.equal(signed(0), '0');
});

test('a network’s capability reads in a few words', () => {
  assert.equal(allowance(CAPABILITIES.mastodon), 'Edit and delete');
  assert.equal(allowance(CAPABILITIES.bluesky), 'Delete only, no edit');
  assert.equal(allowance(CAPABILITIES.devto), 'Edit, and unpublish instead of delete');
  assert.equal(allowance(CAPABILITIES.instagram), 'Neither edit nor delete');
  assert.equal(allowance({ edit: 'yes', delete: 'no' }), 'Edit only');
  assert.equal(allowance({ edit: 'no', delete: 'unpublish' }), 'Unpublish only');
});
