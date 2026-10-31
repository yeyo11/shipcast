import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ago, articleLine, checkSummary, dayLabel, fingerprint, joinDraft, monthGrid, piecesOf, plainText, splitDraft, timeLabel, verdictCounts, zonedParts } from '../src/components/approve/model.ts';

const ARTICLE = '---\ntitle: "pando 1.0"\npubDate: 2026-10-31\nlang: en\n---\n\nYour notes and your code drift apart.\n\n## What you get\n\n- **One index** for docs.\n';
const CHANNEL = '# Bluesky\n\n> **Approval:** published once approved in Shipcast.\n\npando 1.0 is out. https://example.com/?ref=bluesky\n';

test('a draft splits around the text the owner edits, and joins back to the same file', () => {
  const a = splitDraft(ARTICLE, 'article');
  assert.equal(a.body, 'Your notes and your code drift apart.\n\n## What you get\n\n- **One index** for docs.');
  assert.equal(joinDraft(a, a.body), ARTICLE);
  const c = splitDraft(CHANNEL, 'channel');
  assert.equal(c.body, 'pando 1.0 is out. https://example.com/?ref=bluesky');
  assert.equal(joinDraft(c, c.body), CHANNEL);
  assert.equal(joinDraft(c, 'Edited.'), '# Bluesky\n\n> **Approval:** published once approved in Shipcast.\n\nEdited.\n');
});

test('a draft without front matter or a mode line is all text', () => {
  const p = splitDraft('Just text\n', 'channel');
  assert.deepEqual(p, { head: '', body: 'Just text', tail: '\n' });
});

test('the pieces put the article first, its languages together, then one per channel', () => {
  const drafts = [
    { path: 'src/content/posts/es/x.md', label: 'Article (es)', kind: 'article', content: ARTICLE },
    { path: 'src/content/posts/en/x.md', label: 'Article (en)', kind: 'article', content: ARTICLE },
    { path: 'launches/p/v1/bluesky.md', label: 'Bluesky', kind: 'channel', content: CHANNEL },
  ];
  const pieces = piecesOf(drafts, (path) => (path.endsWith('bluesky.md') ? 'bluesky' : undefined), (c) => (c === 'bluesky' ? 'Bluesky' : c));
  assert.deepEqual(
    pieces.map((p) => [p.id, p.name, p.drafts[0]!.path]),
    [
      ['blog', 'Article', 'src/content/posts/en/x.md'],
      ['bluesky', 'Bluesky', 'launches/p/v1/bluesky.md'],
    ],
  );
  assert.match(pieces[0]!.meta, /^Spanish and English · \d+ words$/);
  assert.equal(pieces[1]!.meta, '50 of 300 characters');
  assert.notEqual(fingerprint('a'), fingerprint('b'));
});

test('markdown reads as plain words', () => {
  assert.equal(plainText('## Title\n\n- **Bold** and `code` [a link](https://x)'), 'Title Bold and code a link');
});

test('times read in the owner zone', () => {
  const now = new Date('2026-10-31T10:00:00Z');
  assert.deepEqual(zonedParts('2026-11-02T14:00:00Z', 'Europe/Madrid'), { day: '2026-11-02', time: '15:00' });
  assert.equal(timeLabel('2026-11-02T14:00:00Z', 'Europe/Madrid', now), 'Mon 15:00');
  assert.equal(timeLabel('2026-11-12T14:00:00Z', 'Europe/Madrid', now), 'Thu 12 Nov, 15:00');
  assert.equal(dayLabel('2026-11-05', '15:00'), 'Thu 5 Nov, 15:00');
  assert.equal(ago('2026-10-31T09:57:00Z', now), '3 min ago');
  assert.equal(ago('2026-10-30T09:00:00Z', now), 'yesterday');
});

test('a month starts on its weekday, Monday first', () => {
  assert.deepEqual(monthGrid(2026, 10), { blanks: 6, days: 30 });
  assert.deepEqual(monthGrid(2026, 1), { blanks: 6, days: 28 });
});

test('the article line has its date and reading time', () => {
  assert.equal(articleLine(ARTICLE, 'word '.repeat(1320)), '31 Oct 2026 · 6 min');
});

test('the check is counted and summed up, the worst first', () => {
  const findings = [{ verdict: 'backed' as const }, { verdict: 'backed' as const }, { verdict: 'planned' as const }, { verdict: 'contradicted' as const }];
  assert.deepEqual(
    verdictCounts(findings).map((c) => c.words),
    ['2 backed', '1 planned', '1 says otherwise'],
  );
  assert.equal(checkSummary(findings), 'Last check: 1 claim the code says otherwise');
  assert.equal(checkSummary([{ verdict: 'backed' }]), 'Last check: every claim backed by the code');
});
