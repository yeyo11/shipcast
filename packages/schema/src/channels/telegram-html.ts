/*
 * A Telegram draft's light Markdown as the HTML Telegram's Bot API takes with `parse_mode: 'HTML'`:
 * only the tags it knows (b, i, u, s, tg-spoiler, code, pre, a, blockquote), every other `<`, `>` and
 * `&` escaped, so a draft's `**bold**` is sent as bold rather than with its asterisks. Pure and
 * import-free: the channel's definition counts a post on the text this leaves visible, which is what
 * Telegram counts, and the runtime's adapter sends it. See docs/publishing.md
 */

const escape = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const escapeAttribute = (text: string): string => escape(text).replaceAll('"', '&quot;');

const HOLD = '\u0000';
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const URL = /\bhttps?:\/\/[^\s<>()[\]]+/g;

/** One line's inline Markdown as Telegram's HTML; what is not Markdown is escaped */
function inline(line: string): string {
  const held: string[] = [];
  const hold = (html: string) => `${HOLD}${held.push(html) - 1}${HOLD}`;
  let text = line.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _ticks: string, inner: string) => hold(`<code>${escape(inner.trim())}</code>`));
  // Underline is the one tag a draft writes as HTML, Markdown having none
  text = text.replace(/<u>([\s\S]+?)<\/u>/g, (_m, inner: string) => `${HOLD}u${HOLD}${inner}${HOLD}/u${HOLD}`);
  const links: string[] = [];
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label: string, url: string) => `${HOLD}a${links.push(url) - 1}${HOLD}${label}${HOLD}/a${HOLD}`);
  text = text.replace(URL, (url) => hold(escape(url)));
  text = escape(text);
  const pair = (pattern: RegExp, tag: string) => {
    text = text.replace(pattern, (_m, inner: string) => `<${tag}>${inner}</${tag}>`);
  };
  pair(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, 'b');
  pair(/(?<![\w_])__(?=\S)([\s\S]*?\S)__(?![\w_])/g, 'b');
  pair(/~~(?=\S)([\s\S]*?\S)~~/g, 's');
  pair(/\|\|(?=\S)([\s\S]*?\S)\|\|/g, 'tg-spoiler');
  pair(/(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, 'i');
  pair(/(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/g, 'i');
  return text
    .replace(new RegExp(`${HOLD}a(\\d+)${HOLD}`, 'g'), (_m, n: string) => `<a href="${escapeAttribute(links[Number(n)] ?? '')}">`)
    .replace(new RegExp(`${HOLD}/a${HOLD}`, 'g'), '</a>')
    .replace(new RegExp(`${HOLD}u${HOLD}`, 'g'), '<u>')
    .replace(new RegExp(`${HOLD}/u${HOLD}`, 'g'), '</u>')
    .replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, 'g'), (_m, n: string) => held[Number(n)] ?? '');
}

/**
 * The text as Telegram's HTML. A heading, which Telegram has not, is a bold line; a run of quoted
 * lines one blockquote; a fence a `pre` block; anything else a line of inline Markdown.
 */
export function telegramHtml(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1]!;
      const close = lines.findIndex((l, j) => j > i && l.trim().length >= mark.length && l.trim() === mark[0]!.repeat(l.trim().length));
      if (close > i) {
        const code = escape(lines.slice(i + 1, close).join('\n'));
        out.push(fence[2] ? `<pre><code class="language-${escapeAttribute(fence[2])}">${code}</code></pre>` : `<pre>${code}</pre>`);
        i = close;
        continue;
      }
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) quoted.push(inline(QUOTE.exec(lines[i++]!)![1]!));
      i--;
      out.push(`<blockquote>${quoted.join('\n')}</blockquote>`);
      continue;
    }
    const heading = HEADING.exec(line);
    out.push(heading ? `<b>${inline(heading[1]!)}</b>` : inline(line));
  }
  return out.join('\n');
}

const ENTITIES: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' };

/** What a reader sees of the text once Telegram has read its HTML: the tags gone, the entities read */
export function telegramVisibleText(markdown: string): string {
  return telegramHtml(markdown)
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:amp|lt|gt|quot);/g, (e) => ENTITIES[e] ?? e);
}

/** A Telegram post's length as Telegram counts it: on the visible text, not the Markdown or the tags */
export const telegramLength = (markdown: string): number => telegramVisibleText(markdown).length;
