import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { z } from 'zod';
import { channelTables, CHANNEL_DEFINITIONS, Language, STATS_METRICS, type ChannelDefinition } from '../src/index.ts';

/*
 * Every registered channel goes through the same checks: what one channel's module must hold for the
 * tables derived from it to be right. A new channel passes them or the suite says what it lacks.
 */

const ICONS = fileURLToPath(new URL('../../../design/icons/', import.meta.url));
const definitions: readonly ChannelDefinition[] = CHANNEL_DEFINITIONS;

test('ids, pack keys, limit keys and draft file names are unique across channels', () => {
  const unique = (values: string[], what: string) => assert.equal(new Set(values).size, values.length, `duplicate ${what}: ${values.join(', ')}`);
  unique(definitions.map((d) => d.id), 'id');
  unique(definitions.map((d) => d.pack.key), 'pack key');
  unique(definitions.flatMap((d) => Object.keys(d.limits)), 'limit key');
  // Each channel's files for two parts: one name for a channel with one draft, two for one with parts
  unique(definitions.flatMap((d) => (d.draft ? [...new Set([d.draft.file('en').name, d.draft.file('rust').name])] : [])), 'draft file');
});

for (const d of definitions) {
  test(`${d.id}: the definition is complete and coherent`, () => {
    assert.ok(d.name.trim() && d.inSentence.trim(), 'a name and its in-sentence form');
    assert.equal(d.inSentence.toLowerCase().replace(/^the /, ''), d.name.toLowerCase(), 'the in-sentence form is the name, with "the" where it needs one');
    assert.ok(existsSync(`${ICONS}${d.icon}.svg`), `design/icons/${d.icon}.svg exists`);
    assert.ok(d.brief.startsWith(`${d.pack.key}:`), 'the brief opens with the pack key it writes');
    for (const [, key] of d.brief.matchAll(/\{\{limit\.(\w+)\}\}/g)) assert.ok(key! in d.limits, `{{limit.${key}}} is one of its limits`);

    const piece = d.pack.piece({ z, Language });
    assert.ok(piece.safeParse(undefined).success, 'the piece is optional in the pack');

    if (d.text) {
      assert.ok(Object.values(d.limits).includes(d.text.max), 'the text cap is one of its limits');
      assert.equal(d.text.length('abc'), 3);
    }
    if (d.draft) {
      for (const part of d.id === 'newsletter' ? ['en', 'es'] : d.id === 'reddit' ? ['rust', 'node'] : d.id === 'youtube' ? ['short', 'video'] : ['']) {
        const file = d.draft.file(part);
        assert.match(file.name, /^[a-z0-9-]+\.md$/);
        assert.ok(file.title.trim());
        assert.equal(d.draft.match(file.name), part, `${file.name} is matched back to its part`);
        for (const other of definitions) if (other !== d) assert.equal(other.draft?.match(file.name), undefined, `${file.name} is not ${other.id}'s`);
      }
      assert.equal(typeof d.draft.read('body').text, 'string');
    } else {
      assert.equal(d.publishedBy, 'merge', 'only the blog, published by the merge, has no draft file');
    }

    assert.ok(d.edit.note.trim());
    if (d.edit.edit === 'no') assert.deepEqual([...d.edit.fields], [], 'no edit, no fields');
    else assert.ok(d.edit.fields.length > 0, 'an edit changes some field');
    assert.match(d.edit.main, /^[a-z]+(:\*)?$/);
    if (d.edit.textRequired) assert.ok(d.edit.fields.includes('text'));
    if (d.comments) {
      assert.ok(!d.comments.reply || d.comments.read, 'a reply needs the comments read');
      assert.equal(d.comments.read, d.comments.replyLimit !== undefined, 'a channel that reads comments has a reply limit, and only it');
      if (d.comments.read) assert.ok(d.pack.postText, 'a channel whose comments are answered says what its post said');
    }
    if (d.profile) for (const f of d.profile.editable) assert.ok(d.profile.fields.includes(f));
    if (d.schedulable || d.idempotent) assert.equal(d.publishedBy, 'engine', 'only what the engine publishes is scheduled or retried');
    if (d.metrics) {
      for (const family of Object.keys(d.metrics.families)) assert.ok((STATS_METRICS as readonly string[]).includes(family));
      const readings = Object.values(d.metrics.families).flat();
      for (const name of d.metrics.primary) assert.ok(readings.includes(name), `${name} is one of its readings`);
      // Never read faster than hourly: the owner's rule for every source
      assert.ok(d.metrics.cadence.hours >= 1, `${d.id} is read at most hourly`);
    }
    for (const w of d.posting?.windows ?? []) assert.ok(w.from < w.to && w.weight > 0 && w.weight <= 1);
  });
}

test('a channel added to the registry lands in every derived table from its module alone', () => {
  const fake: ChannelDefinition<'pigeon'> = {
    id: 'pigeon',
    name: 'Pigeon',
    inSentence: 'Pigeon',
    icon: 'pigeon',
    defaultMode: 'off',
    group: 'social',
    publishedBy: 'engine',
    idempotent: true,
    schedulable: true,
    pack: { key: 'pigeon', piece: ({ z: zod }) => zod.strictObject({ text: zod.string() }).optional(), postText: (p: { text: string }) => p.text },
    brief: 'pigeon: one note, at most {{limit.pigeonText}} characters.',
    adapt: 'a short note',
    draft: { file: () => ({ name: 'pigeon.md', title: 'Pigeon' }), match: (n) => (n === 'pigeon.md' ? '' : undefined), read: (body) => ({ text: body }) },
    limits: { pigeonText: 80 },
    text: { max: 80, length: (t) => t.length, counting: 'the link included' },
    edit: { edit: 'yes', delete: 'yes', note: 'By hand', fields: ['text'], main: 'post' },
    comments: { read: true, reply: true, note: 'It coos back', replyLimit: 40 },
    profile: { read: true, edit: 'no', fields: ['bio'], editable: [], limits: {}, note: 'Read only' },
    posting: { note: 'dawn', windows: [{ days: [0], from: 6, to: 8, weight: 1 }] },
    metrics: { families: { reactions: ['coos'] }, primary: ['coos'], cadence: { hours: 1, read: 'batched', why: 'pigeons are quick' } },
    chartSlot: 3,
  };
  const t = channelTables([...CHANNEL_DEFINITIONS, fake]);
  assert.ok(t.ids.includes('pigeon'));
  assert.equal(t.names.pigeon, 'Pigeon');
  assert.equal(t.inSentence.pigeon, 'Pigeon');
  assert.equal(t.icons.pigeon, 'pigeon');
  assert.equal(t.defaultModes.pigeon, 'off');
  assert.equal(t.packKeys.pigeon, 'pigeon');
  assert.deepEqual(t.draftOf('pigeon.md'), { channel: 'pigeon', part: '' });
  assert.equal(t.capabilities.pigeon?.edit, 'yes');
  assert.equal(t.replyCapabilities.pigeon?.reply, true);
  assert.ok(t.commentChannels.includes('pigeon'));
  assert.equal(t.replyLimits.pigeon, 40);
  assert.equal(t.profiles.pigeon?.note, 'Read only');
  assert.equal(t.posting.pigeon?.note, 'dawn');
  assert.deepEqual(t.metricFamilies.pigeon, { reactions: ['coos'] });
  assert.deepEqual(t.primaryMetric.pigeon, ['coos']);
  assert.equal(t.chartSlots.pigeon, 3);
  assert.equal(t.limits.pigeonText, 80);
  assert.equal(t.pieceLimits.pigeon?.network, 'Pigeon');
  assert.equal(t.briefs['channel.pigeon'], fake.brief);
  assert.deepEqual(t.adaptTargets.pigeon, { name: 'Pigeon', limit: 'a short note' });
  assert.ok(t.publishedByEngine.includes('pigeon') && t.schedulable.includes('pigeon') && t.idempotent.includes('pigeon'));
  assert.ok(!t.longForm.includes('pigeon'));
});
