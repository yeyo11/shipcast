import assert from 'node:assert/strict';
import { test } from 'node:test';
import { htmlToMarkdown } from '../src/sources/html.ts';

const BASE = 'https://example.com/blog/post';

test('the content of <main> is preferred over the rest of the body', () => {
  const html = `<html><body>
    <header><p>Site header</p></header>
    <main><h1>The post</h1><p>What it says.</p></main>
    <p>Outside main</p>
  </body></html>`;
  const { markdown } = htmlToMarkdown(html, BASE);
  assert.equal(markdown, '# The post\n\nWhat it says.');
});

test('the articles are read when there is no <main>', () => {
  const html = `<body><nav><a href="/">Home</a></nav>
    <article><h2>First</h2><p>One</p></article>
    <div class="sidebar">Elsewhere</div>
    <article><h2>Second</h2><p>Two</p></article></body>`;
  const { markdown } = htmlToMarkdown(html, BASE);
  assert.equal(markdown, '## First\n\nOne\n\n## Second\n\nTwo');
});

test('without main or article, the body is read without nav, footer and aside', () => {
  const html = `<body>
    <nav><ul><li><a href="/a">Menu A</a></li></ul></nav>
    <div><p>The text.</p></div>
    <aside>Related posts</aside>
    <footer>© 2026 Someone</footer>
  </body>`;
  const { markdown } = htmlToMarkdown(html, BASE);
  assert.equal(markdown, 'The text.');
});

test('links and images are made absolute, and only http(s) links are kept as links', () => {
  const html = `<main>
    <p>See <a href="../docs/start?x=1">the guide</a>, <a href="https://other.org/a">another</a>,
    <a href="javascript:alert(1)">a script</a>, <a href="mailto:me@example.com">mail</a> and <a href="#top">top</a>.</p>
    <p><img src="/img/shot.png" alt="A screenshot"> <img src="/img/deco.png" alt=""> <img src="data:image/png;base64,AAAA" alt="inline"></p>
  </main>`;
  const { markdown } = htmlToMarkdown(html, BASE);
  assert.match(markdown, /\[the guide\]\(https:\/\/example\.com\/docs\/start\?x=1\)/);
  assert.match(markdown, /\[another\]\(https:\/\/other\.org\/a\)/);
  assert.match(markdown, /\[top\]\(https:\/\/example\.com\/blog\/post#top\)/);
  assert.match(markdown, / a script, mail and /);
  assert.doesNotMatch(markdown, /javascript:|mailto:/);
  assert.match(markdown, /!\[A screenshot\]\(https:\/\/example\.com\/img\/shot\.png\)/);
  assert.doesNotMatch(markdown, /deco\.png|data:/);
});

test('a <base href> moves where relative links point', () => {
  const html = '<head><base href="https://cdn.example.net/root/"></head><main><a href="page">Page</a></main>';
  assert.equal(htmlToMarkdown(html, BASE).markdown, '[Page](https://cdn.example.net/root/page)');
});

test('entities are decoded, named and numeric', () => {
  const html = '<main><p>Caf&eacute; &amp; t&#233; &#x1F680; &lt;tag&gt; &quot;q&quot; a&nbsp;b &copy; &unknown; &#0;</p></main>';
  assert.equal(htmlToMarkdown(html, BASE).markdown, 'Café & té 🚀 <tag> "q" a b © &unknown; �');
});

test('script, style and other non-content never appear, even with markup inside them', () => {
  const html = `<html><head><style>p { color: red }</style><script>var secret = "<p>leak</p>";</script></head>
    <body><main><p>Visible</p>
    <script type="module">document.write('<h1>injected</h1>')</script>
    <noscript>Enable JavaScript</noscript><template><p>template text</p></template>
    <svg><text>svg text</text></svg><iframe src="x">frame text</iframe><canvas>canvas text</canvas>
    <!-- a comment <p>hidden</p> -->
    <form><label>Email</label><input name="e"><button>Send</button></form>
    <p>Also visible</p><script>unterminated = "</main>`;
  const { markdown } = htmlToMarkdown(html, BASE);
  assert.equal(markdown, 'Visible\n\nAlso visible');
});

test('a page that is one big form keeps its text', () => {
  const html = '<body><form action="/x"><div><h1>Old site</h1><p>Its text</p></div><input type="hidden" name="v"></form></body>';
  assert.equal(htmlToMarkdown(html, BASE).markdown, '# Old site\n\nIts text');
});

test('the title comes from <title>, else from og:title', () => {
  assert.equal(htmlToMarkdown('<head><title> My  &amp; page </title><meta property="og:title" content="OG"></head><p>x</p>', BASE).title, 'My & page');
  assert.equal(htmlToMarkdown('<head><meta property="og:title" content="The OG title"></head><p>x</p>', BASE).title, 'The OG title');
  assert.equal(htmlToMarkdown('<p>x</p>', BASE).title, undefined);
  assert.equal('title' in htmlToMarkdown('<p>x</p>', BASE), false);
});

test('structure becomes Markdown: headings, lists, emphasis, code, quotes, line breaks', () => {
  const html = `<main>
    <h2>Install</h2>
    <p>Run <code>pnpm i</code> then <strong>build</strong> and <em>enjoy</em>.<br>Second line</p>
    <ul><li>One<li>Two<ul><li>Nested</li></ul></li></ul>
    <ol start="3"><li>Three</li><li>Four</li></ol>
    <pre><code class="language-ts">const a = 1;
if (a &lt; 2) {
  go();
}</code></pre>
    <blockquote><p>Quoted</p><p>Twice</p></blockquote>
    <p>Lots    of
       spaces</p>
  </main>`;
  const { markdown } = htmlToMarkdown(html, BASE);
  assert.equal(
    markdown,
    [
      '## Install',
      'Run `pnpm i` then **build** and _enjoy_.\nSecond line',
      '- One\n- Two\n  - Nested',
      '3. Three\n4. Four',
      '```ts\nconst a = 1;\nif (a < 2) {\n  go();\n}\n```',
      '> Quoted\n>\n> Twice',
      'Lots of spaces',
    ].join('\n\n'),
  );
});

test('a page made to slow the converter down does not: a long run of spaces before text converts in linear time', () => {
  // A trailing-whitespace regex (/\s+$/) retries from every space of the run: 80k of them took seconds
  const run = ' '.repeat(80_000);
  const started = performance.now();
  const { markdown } = htmlToMarkdown(`<main><pre>${run}x${run}x</pre><p><strong>${run}y${run}</strong></p></main>`, BASE);
  assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)} ms`);
  assert.ok(markdown.startsWith('```\n'));
  assert.ok(markdown.includes('**y**'));
});
