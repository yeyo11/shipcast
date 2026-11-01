import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelTables, CHANNEL_DEFINITIONS, checkFormat, imageAltProblem, EDITOR_PROFILES, editorProfile, formatProblem, PIECE_LIMITS, stripFormat, telegramHtml, telegramLength, telegramVisibleText, type EditorProfile } from '../src/index.ts';

/*
 * The formatting profile on each channel's definition and the checks that read it
 * (docs/decisions/rich-editor.md), and Telegram's HTML (docs/publishing.md).
 */

const summary = (p: EditorProfile | undefined) => p && `${p.format} | ${p.marks.join(' ')} | ${p.blocks.join(' ')}${p.maxHeading ? ` h${p.maxHeading}` : ''} | ${p.images ? 'images' : 'no images'}`;

test('each channel’s profile, derived from its definition', () => {
  const full = 'markdown | bold italic strike code link | heading quote bulletList orderedList taskList codeBlock table | images';
  const plain = 'plain |  |  | no images';
  assert.deepEqual(Object.fromEntries(CHANNEL_DEFINITIONS.map((d) => [d.id, summary(EDITOR_PROFILES[d.id])])), {
    blog: full,
    devto: full,
    bluesky: plain,
    mastodon: plain,
    instagram: plain,
    reddit: 'markdown | bold italic strike code link | heading quote bulletList orderedList codeBlock table | no images',
    hashnode: full,
    linkedin: plain,
    newsletter: 'light | bold italic link | bulletList orderedList | no images',
    telegram: 'light | bold italic underline strike spoiler code link | quote | no images',
    discord: 'light | bold italic strike code link spoiler | heading quote bulletList orderedList codeBlock h3 | no images',
    githubDiscussions: full,
    threads: plain,
    youtube: undefined,
  });
  // A text of no channel is the article, as on Write
  assert.equal(editorProfile(undefined), EDITOR_PROFILES.blog);
  // A new channel's profile lands in the table from its module alone
  const pigeon = { ...CHANNEL_DEFINITIONS[2], id: 'pigeon', editor: { ...EDITOR_PROFILES.bluesky!, note: 'Pigeon' } } as never;
  assert.equal(channelTables([pigeon]).editorProfiles.pigeon?.note, 'Pigeon');
});

const bluesky = EDITOR_PROFILES.bluesky!;
const telegram = EDITOR_PROFILES.telegram!;
const discord = EDITOR_PROFILES.discord!;
const blog = EDITOR_PROFILES.blog!;

test('checkFormat finds what a plain network would show as typed, each kind once', () => {
  const text = 'Shipped **v1.0** of `claudio` with _real_ fixes and **more**. [Read](https://x.dev/a?ref=bluesky)\n## Why\n> quote';
  assert.deepEqual(
    checkFormat(text, bluesky).map((p) => p.syntax),
    ['code', 'link', 'bold', 'italic', 'heading', 'quote'],
  );
  assert.deepEqual(checkFormat(text, blog), []);
});

test('checkFormat reads no formatting into code, URLs, snake_case or arithmetic, and lists read as typed', () => {
  const text = [
    'See https://x.dev/snake_case_url_here and my_var_name, 5 * 3 * 2.',
    '- one',
    '1. two',
    '```',
    '**not bold** # not a heading',
    '```',
  ].join('\n');
  assert.deepEqual(checkFormat(text, { ...bluesky, blocks: ['codeBlock'] }), []);
  // The fence itself is syntax a plain network does not show
  assert.deepEqual(checkFormat(text, bluesky).map((p) => p.syntax), ['codeBlock']);
  assert.deepEqual(checkFormat('Use `**x**` here', { ...bluesky, marks: ['code'] }), []);
});

test('checkFormat reads a light profile: Discord’s headings stop at the third, its tables are not shown', () => {
  assert.deepEqual(checkFormat('### Fine\n#### Too deep', discord).map((p) => p.syntax), ['heading']);
  assert.deepEqual(checkFormat('| a | b |\n|---|---|\n| 1 | 2 |', discord).map((p) => p.syntax), ['table']);
  assert.deepEqual(checkFormat('<u>under</u> ||spoiler|| ~~gone~~', telegram), []);
  assert.deepEqual(checkFormat('![a cat](/articles/x/cat.png)', discord).map((p) => p.syntax), ['image']);
});

test('stripFormat keeps the words and takes out the syntax', () => {
  const text = 'Shipped **v1.0** of `claudio`. [Read it](https://x.dev/a_b?ref=bluesky) or [https://x.dev](https://x.dev)\n## Why\n> quoted\n- [ ] task\n| a | b |\n|---|---|\n| 1 | 2 |\n![a cat](/c.png)';
  const { text: cleaned, removed } = stripFormat(text, bluesky);
  assert.equal(cleaned, 'Shipped v1.0 of claudio. Read it (https://x.dev/a_b?ref=bluesky) or https://x.dev\nWhy\nquoted\n- task\na · b\n1 · 2\na cat');
  assert.deepEqual(removed.sort(), ['bold', 'code', 'heading', 'image', 'link', 'quote', 'table', 'taskList']);
  // A heading too deep for Discord is brought up to its deepest, not flattened
  assert.equal(stripFormat('#### Deep', discord).text, '### Deep');
  assert.deepEqual(stripFormat('Nothing to do', bluesky), { text: 'Nothing to do', removed: [] });
});

test('formatProblem names the network and the syntax, as the save refuses it', () => {
  assert.equal(formatProblem('Bluesky', 'It is **out**', bluesky), 'Bluesky does not show bold (**out**): write it as plain text');
  assert.equal(formatProblem('Discord', '| a |\n|---|', discord), 'Discord does not show tables (| a |): take it out');
  assert.equal(formatProblem('Bluesky', 'Plain', bluesky), undefined);
});

test('Telegram: light Markdown as its HTML, everything else escaped', () => {
  assert.equal(
    telegramHtml('**bold** _it_ *it* <u>under</u> ||spoiler|| ~~gone~~ `a<b` & 1 < 2 > 0'),
    '<b>bold</b> <i>it</i> <i>it</i> <u>under</u> <tg-spoiler>spoiler</tg-spoiler> <s>gone</s> <code>a&lt;b</code> &amp; 1 &lt; 2 &gt; 0',
  );
  assert.equal(telegramHtml('[read "it"](https://x.dev/?a=1&b=2)'), '<a href="https://x.dev/?a=1&amp;b=2">read "it"</a>');
  assert.equal(telegramHtml('See https://x.dev/snake_case_url?a=1&b=2'), 'See https://x.dev/snake_case_url?a=1&amp;b=2');
  assert.equal(telegramHtml('> one\n> two\n# Title\n```ts\nif (a<b) {}\n```'), '<blockquote>one\ntwo</blockquote>\n<b>Title</b>\n<pre><code class="language-ts">if (a&lt;b) {}</code></pre>');
  assert.equal(telegramHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('Telegram counts the text a reader sees: not the Markdown, the tags or a link’s address', () => {
  assert.equal(telegramVisibleText('**bold** [label](https://x.dev/a/long/url) & <x>'), 'bold label & <x>');
  assert.equal(telegramLength('**bold** [label](https://x.dev/a/long/url)'), 10);
  const text = `**${'a'.repeat(898)}**`;
  assert.equal(PIECE_LIMITS.telegram!.length(text), 898);
});

test('an image needs alt text, within the blog’s cap; an image in code is not one', () => {
  assert.equal(imageAltProblem('![The setup](/a/shot.png)', 140), undefined);
  assert.equal(imageAltProblem('Text ![ ](/articles/x/shot.png)', 140), 'The image shot.png has no alt text: say in a few words what it shows');
  assert.equal(imageAltProblem(`![${'a'.repeat(141)}](/s.png)`, 140), 'The alt text of s.png has 141 characters; at most 140');
  assert.equal(imageAltProblem('`![](/s.png)`\n\n```\n![](/t.png)\n```', 140), undefined);
});
