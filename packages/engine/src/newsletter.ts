import { projectLook } from '@shipcast/assets';
import type { Brand, Language } from '@shipcast/schema';
import { Marked } from 'marked';

/** One issue as edited in the drafts pull request: what the subscriber sees in the inbox, and the body. */
export interface NewsletterIssue {
  subject: string;
  previewText: string;
  markdown: string;
}

const COPY: Record<Language, { read: string; why: string; unsubscribe: string }> = {
  en: { read: 'Read the article', why: 'You get this because you subscribed at', unsubscribe: 'Unsubscribe' },
  es: { read: 'Leer el artículo', why: 'Te llega porque te suscribiste en', unsubscribe: 'Darte de baja' },
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The draft file of one issue: the subject and preview as labelled lines, then the body. */
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

/**
 * The issue as an email: the launch image linking to the article, the headline on the project's
 * colour as on the blog, the note, a button to the article and the unsubscribe line Brevo fills in.
 * Tables and inline styles, since that is what every mail client renders the same.
 */
export function renderIssueHtml(issue: NewsletterIssue, options: { brand: Brand; project: string; title: string; articleUrl: string; imageUrl?: string; lang: Language }): string {
  const { brand, lang } = options;
  const copy = COPY[lang];
  const colour = projectLook(options.project).colour;
  const marked = new Marked({ gfm: true, breaks: false });
  const body = (marked.parse(issue.markdown, { async: false }) as string)
    .replace(/<p>/g, '<p style="margin:0 0 18px;font:18px/1.6 Georgia,\'Times New Roman\',serif;color:#22211f">')
    .replace(/<a /g, '<a style="color:#000;text-decoration:underline" ')
    .replace(/<(ul|ol)>/g, '<$1 style="margin:0 0 18px;padding-left:22px;font:18px/1.6 Georgia,serif;color:#22211f">')
    .replace(/<code>/g, '<code style="font:15px Menlo,Consolas,monospace;background:#f2f1ed;padding:1px 4px">');
  const image = options.imageUrl
    ? `<tr><td><a href="${esc(options.articleUrl)}"><img src="${esc(options.imageUrl)}" width="600" alt="${esc(options.title)}" style="display:block;width:100%;height:auto;border:0"></a></td></tr>`
    : '';
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(issue.subject)}</title></head>
<body style="margin:0;padding:0;background:#f5f2ea">
<div style="display:none;max-height:0;overflow:hidden">${esc(issue.previewText)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f2ea"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:2px solid #000">
<tr><td style="padding:20px 28px;font:italic 20px Georgia,serif;color:#000;border-bottom:2px solid #000">${esc(brand.displayName)}</td></tr>
${image}
<tr><td style="background:${colour};padding:22px 28px;border-top:2px solid #000;border-bottom:2px solid #000"><h1 style="margin:0;font:400 30px/1.15 Georgia,serif;color:#000">${esc(options.title)}</h1></td></tr>
<tr><td style="padding:28px 28px 8px">${body}</td></tr>
<tr><td style="padding:0 28px 32px"><a href="${esc(options.articleUrl)}" style="display:inline-block;background:#000;color:#fff;font:600 16px Helvetica,Arial,sans-serif;text-decoration:none;padding:14px 26px;border-radius:999px">${copy.read}</a></td></tr>
</table>
<p style="max-width:600px;margin:18px auto 0;font:13px/1.5 Helvetica,Arial,sans-serif;color:#5c5a54">${copy.why} <a href="${esc(brand.site)}" style="color:#5c5a54">${esc(new URL(brand.site).host)}</a>. <a href="{{ unsubscribe }}" style="color:#5c5a54">${copy.unsubscribe}</a></p>
</td></tr></table>
</body></html>`;
}
