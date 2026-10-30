/**
 * A small HTML to Markdown converter for a source page an analysis reads: the text, its structure
 * (headings, lists, quotes, code) and its links, without the page's chrome. Not a browser: it is
 * tolerant of broken markup rather than exact about it, which is all a model reading the page needs.
 */

interface Element {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}
type Node = Element | string;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', minus: '−',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»',
  lsaquo: '‹', rsaquo: '›', bull: '•', middot: '·', deg: '°', euro: '€', pound: '£', yen: '¥', cent: '¢',
  sect: '§', para: '¶', times: '×', divide: '÷', plusmn: '±', frac12: '½', frac14: '¼', frac34: '¾',
  iexcl: '¡', iquest: '¿', ordf: 'ª', ordm: 'º', sup1: '¹', sup2: '²', sup3: '³', micro: 'µ',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', rArr: '⇒', lArr: '⇐', check: '✓',
  dagger: '†', Dagger: '‡', permil: '‰', prime: '′', Prime: '″', zwj: '‍', zwnj: '‌',
  ensp: ' ', emsp: ' ', thinsp: ' ',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', yacute: 'ý',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Yacute: 'Ý',
  agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù',
  Agrave: 'À', Egrave: 'È', Igrave: 'Ì', Ograve: 'Ò', Ugrave: 'Ù',
  acirc: 'â', ecirc: 'ê', icirc: 'î', ocirc: 'ô', ucirc: 'û',
  Acirc: 'Â', Ecirc: 'Ê', Icirc: 'Î', Ocirc: 'Ô', Ucirc: 'Û',
  auml: 'ä', euml: 'ë', iuml: 'ï', ouml: 'ö', uuml: 'ü', yuml: 'ÿ',
  Auml: 'Ä', Euml: 'Ë', Iuml: 'Ï', Ouml: 'Ö', Uuml: 'Ü',
  atilde: 'ã', otilde: 'õ', ntilde: 'ñ', Atilde: 'Ã', Otilde: 'Õ', Ntilde: 'Ñ',
  ccedil: 'ç', Ccedil: 'Ç', aring: 'å', Aring: 'Å', aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø',
  szlig: 'ß', eth: 'ð', thorn: 'þ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      // NUL, surrogates and anything past Unicode are what a browser replaces too
      if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

// Elements whose content is not markup: their text is cut out before the markup is read, so a `<`
// inside a script can never open an element, and none of it can reach the Markdown
const RAW_TEXT = ['script', 'style', 'noscript', 'iframe', 'textarea', 'title', 'xmp', 'noembed', 'noframes'];

/** The document without comments and raw-text elements, and the text of its first `<title>` */
function stripRaw(html: string): { html: string; title: string | undefined } {
  const opener = new RegExp(`<!--|<(${RAW_TEXT.join('|')})\\b[^>]*>`, 'gi');
  let out = '';
  let title: string | undefined;
  let from = 0;
  for (;;) {
    opener.lastIndex = from;
    const match = opener.exec(html);
    if (!match) break;
    out += html.slice(from, match.index);
    const contentStart = match.index + match[0].length;
    const name = match[1]?.toLowerCase();
    // An element or a comment that is never closed runs to the end of the document, as in a browser
    let end: number;
    let after: number;
    if (name === undefined) {
      end = html.indexOf('-->', contentStart);
      after = end === -1 ? html.length : end + 3;
    } else {
      const closer = new RegExp(`</${name}\\s*>`, 'i');
      const close = closer.exec(html.slice(contentStart));
      end = close ? contentStart + close.index : html.length;
      after = close ? end + close[0].length : html.length;
      if (name === 'title' && title === undefined) title = collapse(decodeEntities(html.slice(contentStart, end)));
    }
    // A space keeps the words on either side of a removed element apart
    out += ' ';
    from = after;
  }
  return { html: out + html.slice(from), title };
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'html',
  'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

// Elements that never carry what a reader came for: graphics, embeds, controls, the head
const DROPPED = new Set(['head', 'svg', 'math', 'template', 'canvas', 'object', 'embed', 'select', 'button', 'input', 'video', 'audio', 'picture', 'map']);

function parseAttributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of text.matchAll(pattern)) {
    const name = match[1]?.toLowerCase();
    if (name && !(name in attrs)) attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

/** Builds a tree from markup, closing what HTML closes implicitly and ignoring stray end tags */
function parse(html: string): Element {
  const root: Element = { tag: '#root', attrs: {}, children: [] };
  const stack: Element[] = [root];
  const top = (): Element => stack[stack.length - 1] ?? root;
  const popTo = (index: number): void => {
    stack.length = Math.max(index, 1);
  };
  const lastOpen = (tag: string, stopAt: readonly string[] = []): number => {
    for (let i = stack.length - 1; i > 0; i--) {
      const name = stack[i]?.tag;
      if (name === tag) return i;
      if (name !== undefined && stopAt.includes(name)) return -1;
    }
    return -1;
  };
  const tokens = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|<![^>]*>|<\?[^>]*>/g;
  let from = 0;
  for (const match of html.matchAll(tokens)) {
    if (match.index > from) top().children.push(html.slice(from, match.index));
    from = match.index + match[0].length;
    const name = match[2]?.toLowerCase();
    if (name === undefined) continue;
    if (match[1] === '/') {
      const open = lastOpen(name);
      if (open > 0) popTo(open);
      continue;
    }
    // A list item, a term or a cell ends the previous one of its list, and a block ends an open paragraph
    if (name === 'li') {
      const open = lastOpen('li', ['ul', 'ol']);
      if (open > 0) popTo(open);
    } else if (name === 'dt' || name === 'dd') {
      const open = Math.max(lastOpen('dt', ['dl']), lastOpen('dd', ['dl']));
      if (open > 0) popTo(open);
    } else if (name === 'tr') {
      const open = lastOpen('tr', ['table']);
      if (open > 0) popTo(open);
    } else if (name === 'td' || name === 'th') {
      const open = Math.max(lastOpen('td', ['tr', 'table']), lastOpen('th', ['tr', 'table']));
      if (open > 0) popTo(open);
    }
    if (BLOCK.has(name)) {
      const open = lastOpen('p');
      if (open > 0 && stack.slice(open + 1).every((e) => !BLOCK.has(e.tag))) popTo(open);
    }
    const attributes = match[3] ?? '';
    const element: Element = { tag: name, attrs: parseAttributes(attributes), children: [] };
    top().children.push(element);
    if (!VOID.has(name) && !attributes.trimEnd().endsWith('/')) stack.push(element);
  }
  if (from < html.length) top().children.push(html.slice(from));
  return root;
}

function find(node: Element, tag: string): Element[] {
  const found: Element[] = [];
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    if (child.tag === tag) found.push(child);
    else found.push(...find(child, tag));
  }
  return found;
}

function without(node: Element, tags: ReadonlySet<string>): Element {
  return {
    ...node,
    children: node.children.filter((c) => typeof c === 'string' || !tags.has(c.tag)).map((c) => (typeof c === 'string' ? c : without(c, tags))),
  };
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function absolute(href: string | undefined, base: URL | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href.trim(), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function textContent(node: Node): string {
  if (typeof node === 'string') return decodeEntities(node);
  return node.tag === 'br' ? '\n' : node.children.map(textContent).join('');
}

/** Wraps text in a marker, keeping its surrounding spaces outside, where Markdown expects them */
function mark(text: string, marker: string): string {
  const inner = text.trim();
  if (inner === '') return text;
  const lead = /^\s*/.exec(text)?.[0] ?? '';
  // trimEnd, not /\s*$/: that regex retries from every space of a long run, quadratic on a hostile page
  const trail = text.slice(text.trimEnd().length);
  return `${lead}${marker}${inner}${marker}${trail}`;
}

function codeSpan(text: string): string {
  const inner = text.replace(/\s+/g, ' ');
  if (inner.trim() === '') return '';
  return inner.includes('`') ? `\`\` ${inner} \`\`` : `\`${inner}\``;
}

class Renderer {
  readonly #base: URL | undefined;

  constructor(base: URL | undefined) {
    this.#base = base;
  }

  inline(nodes: readonly Node[]): string {
    return nodes.map((node) => this.inlineNode(node)).join('');
  }

  inlineNode(node: Node): string {
    if (typeof node === 'string') return decodeEntities(node.replace(/[ \t\n\r\f]+/g, ' ')).replace(/ /g, ' ');
    switch (node.tag) {
      case 'br':
        return '\n';
      case 'img': {
        const alt = collapse(node.attrs.alt ?? '');
        const src = absolute(node.attrs.src, this.#base);
        return alt && src ? `![${alt.replace(/[[\]]/g, '\\$&')}](${src})` : '';
      }
      case 'a': {
        const text = this.inline(node.children);
        const href = absolute(node.attrs.href, this.#base);
        const label = collapse(text);
        if (!href || label === '') return text;
        const lead = /^\s/.test(text) ? ' ' : '';
        const trail = /\s$/.test(text) ? ' ' : '';
        // Parentheses would end the Markdown link early; the URL parser already encoded any space
        return `${lead}[${label}](${href.replace(/\(/g, '%28').replace(/\)/g, '%29')})${trail}`;
      }
      case 'strong':
      case 'b':
        return mark(this.inline(node.children), '**');
      case 'em':
      case 'i':
        return mark(this.inline(node.children), '_');
      case 'code':
      case 'kbd':
      case 'samp':
        return codeSpan(textContent(node));
      default:
        // A block inside inline content (a div in a heading, a paragraph in a link) is a run of words
        return BLOCK.has(node.tag) ? ` ${this.inline(node.children)} ` : this.inline(node.children);
    }
  }

  /** The Markdown blocks of a container's children: runs of inline content become paragraphs */
  blocks(nodes: readonly Node[]): string[] {
    const out: string[] = [];
    let run: Node[] = [];
    const flush = (): void => {
      const paragraph = tidy(this.inline(run));
      if (paragraph !== '') out.push(paragraph);
      run = [];
    };
    for (const node of nodes) {
      if (typeof node !== 'string' && BLOCK.has(node.tag)) {
        flush();
        out.push(...this.block(node));
      } else {
        run.push(node);
      }
    }
    flush();
    return out;
  }

  block(node: Element): string[] {
    const heading = /^h([1-6])$/.exec(node.tag);
    if (heading?.[1]) {
      const text = collapse(this.inline(node.children));
      return text === '' ? [] : [`${'#'.repeat(Number(heading[1]))} ${text}`];
    }
    switch (node.tag) {
      case 'hr':
        return ['---'];
      case 'pre': {
        const code = node.children.find((c): c is Element => typeof c !== 'string' && c.tag === 'code');
        const language = /(?:^|\s)(?:language|lang)-([\w+#-]+)/.exec(code?.attrs.class ?? '')?.[1] ?? '';
        const text = textContent(node).replace(/^\n/, '').trimEnd(); // not /\s+$/, quadratic on a long run of spaces
        if (text === '') return [];
        const fence = text.includes('```') ? '~~~' : '```';
        return [`${fence}${language}\n${text}\n${fence}`];
      }
      case 'blockquote': {
        const inner = this.blocks(node.children).join('\n\n');
        return inner === '' ? [] : [inner.split('\n').map((line) => (line === '' ? '>' : `> ${line}`)).join('\n')];
      }
      case 'ul':
      case 'ol':
        return this.list(node);
      case 'table':
        return this.table(node);
      default:
        return this.blocks(node.children);
    }
  }

  list(node: Element): string[] {
    const ordered = node.tag === 'ol';
    let number = Number.parseInt(node.attrs.start ?? '1', 10);
    if (!Number.isFinite(number)) number = 1;
    const items: string[] = [];
    for (const child of node.children) {
      if (typeof child === 'string') {
        if (child.trim() !== '') items.push(`- ${tidy(this.inlineNode(child))}`);
        continue;
      }
      if (child.tag !== 'li') {
        items.push(...this.block(child));
        continue;
      }
      const marker = ordered ? `${number++}. ` : '- ';
      const body = this.blocks(child.children).join('\n');
      if (body === '') continue;
      const indent = ' '.repeat(marker.length);
      items.push(body.split('\n').map((line, i) => (i === 0 ? marker + line : line === '' ? '' : indent + line)).join('\n'));
    }
    return items.length === 0 ? [] : [items.join('\n')];
  }

  table(node: Element): string[] {
    const rows = find(node, 'tr')
      .map((row) =>
        row.children
          .filter((c): c is Element => typeof c !== 'string' && (c.tag === 'td' || c.tag === 'th'))
          .map((cell) => collapse(this.inline(cell.children)).replace(/\|/g, '\\|')),
      )
      .filter((cells) => cells.some((c) => c !== ''));
    return rows.length === 0 ? [] : [rows.map((cells) => `| ${cells.join(' | ')} |`).join('\n')];
  }
}

/** Collapses the spaces of a paragraph, keeping the line breaks a `<br>` asked for */
function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function render(region: Element, base: URL | undefined): string {
  return new Renderer(base).blocks(region.children).join('\n\n');
}

/**
 * The readable content of an HTML page as Markdown, with its title: the page's `<main>` or its
 * `<article>`s when it marks its content, else its body without navigation, footer and asides.
 * Scripts, styles, forms and embeds are dropped; links and images point to absolute http(s) URLs.
 */
export function htmlToMarkdown(html: string, baseUrl: string): { title?: string; markdown: string } {
  const stripped = stripRaw(html);
  const root = parse(stripped.html);

  let base: URL | undefined;
  try {
    base = new URL(baseUrl);
  } catch {
    base = undefined;
  }
  // A page's <base href> moves where its relative links point
  const baseHref = find(root, 'base')[0]?.attrs.href;
  if (baseHref) {
    try {
      base = new URL(baseHref, base);
    } catch {
      // A base that does not parse is ignored, as browsers do
    }
  }

  let title = stripped.title;
  if (!title) {
    const og = find(root, 'meta').find((m) => (m.attrs.property ?? m.attrs.name)?.toLowerCase() === 'og:title');
    title = og?.attrs.content ? collapse(og.attrs.content) : undefined;
  }

  const content = without(root, DROPPED);
  const main = find(content, 'main');
  const articles = main.length > 0 ? main : find(content, 'article');
  let region: Element;
  if (articles.length > 0) {
    region = { tag: 'div', attrs: {}, children: articles };
  } else {
    region = without(find(content, 'body')[0] ?? content, new Set(['nav', 'footer', 'aside']));
  }

  // Forms go too, unless the page is one (ASP.NET wraps the whole body in a <form>): then only its
  // controls, already dropped, go
  let markdown = render(without(region, new Set(['form'])), base);
  if (markdown === '') markdown = render(region, base);
  return { ...(title && { title }), markdown };
}
