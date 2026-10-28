/*
 * How networks count a text, and how a draft's text is laid out and read back: pure and import-free,
 * shared by the channel definitions, the engine that publishes the drafts and the browser's editor.
 */

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Bluesky counts graphemes, so an emoji or an accented letter is one, as a reader sees it. */
export function graphemeCount(text: string): number {
  let count = 0;
  for (const _ of graphemes.segment(text)) count++;
  return count;
}

const utf8 = new TextEncoder();

/** Threads counts a character as one but an emoji as its UTF-8 bytes (four, or more for a joined one) */
export function threadsLength(text: string): number {
  let count = 0;
  for (const { segment } of graphemes.segment(text)) count += /\p{Extended_Pictographic}/u.test(segment) ? utf8.encode(segment).length : 1;
  return count;
}

/** Characters as JavaScript counts them, which is how most networks' limits read */
export const characters = (text: string): number => text.length;

/** The draft of a discussion: its title on a line of its own, then the body after a `---` line */
export function discussionDraft(piece: { title: string; body: string }): string {
  return `Title: ${piece.title}\n\n---\n\n${piece.body.trim()}`;
}

/** Splits a discussion draft as edited; a draft whose title line is gone keeps the pack's title */
export function parseDiscussionDraft(body: string, fallback: { title: string; body: string }): { title: string; body: string } {
  const [head, ...rest] = body.split(/^---$/m);
  const title = /^Title: (.+)$/m.exec(head ?? '')?.[1]?.trim() || fallback.title;
  const text = rest.length > 0 ? rest.join('---').trim() : body.trim();
  return { title, body: text || fallback.body };
}

/** Splits an Instagram draft as edited: the caption after the `---` line, the comment on its line. */
export function parseInstagramDraft(body: string): { caption: string; comment: string | undefined } {
  const [head, ...rest] = body.split(/^---$/m);
  const caption = rest.length > 0 ? rest.join('---').trim() : body.trim();
  return { caption, comment: /^Comment: (.+)$/m.exec(head ?? '')?.[1]?.trim() };
}

/** One issue as edited in the drafts pull request: what the subscriber sees in the inbox, and the body. */
export interface NewsletterIssue {
  subject: string;
  previewText: string;
  markdown: string;
}

/** The draft of an issue: the subject and preview on their lines, then the body. */
export function issueDraftBody(issue: NewsletterIssue): string {
  return `Subject: ${issue.subject}\nPreview: ${issue.previewText}\n\n${issue.markdown.trim()}`;
}

/** Reads an issue back from its draft as edited, falling back to the pack's for what is missing. */
export function parseIssueDraft(body: string, fallback: NewsletterIssue): NewsletterIssue {
  const subject = /^Subject: (.+)$/m.exec(body)?.[1]?.trim();
  const previewText = /^Preview: (.+)$/m.exec(body)?.[1]?.trim();
  const markdown = body.replace(/^(Subject|Preview): .*\n?/gm, '').trim();
  return { subject: subject || fallback.subject, previewText: previewText || fallback.previewText, markdown: markdown || fallback.markdown };
}

/** The file of a channel whose piece is one draft: `<stem>.md`, matched by that name alone */
export function singleDraft(stem: string, title: string) {
  const name = `${stem}.md`;
  return {
    file: () => ({ name, title }),
    match: (file: string) => (file === name ? '' : undefined),
  };
}
