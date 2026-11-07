import { byLanguage, QUARTER_HOUR_BATCHED, MIDWEEK, WORKDAYS, type ChannelDefinition, type PieceKit } from './definition.ts';
import { parseIssueDraft } from './text.ts';

const limits = { newsletterSubject: 90, newsletterPreview: 140 } as const;

function piece(kit: PieceKit) {
  const { z } = kit;
  const issue = z.strictObject({
    subject: z.string().min(1).max(limits.newsletterSubject),
    previewText: z.string().min(1).max(limits.newsletterPreview).describe('The preheader inbox apps show after the subject'),
    markdown: z
      .string()
      .min(1)
      .describe('The email body in Markdown: a short, personal note on what shipped and why it matters, linking the article; not the article itself'),
  });
  return byLanguage(kit, {}, issue, kit.languages?.newsletter, 'the issue needs at least one language')
    .optional()
    .describe("The newsletter issue, one per language the brand's newsletter has a list for");
}

const DRAFT = /^newsletter-([a-z]{2})\.md$/;

/** The newsletter, sent through Brevo: one issue per language the brand has a list for */
export const newsletter = {
  id: 'newsletter',
  name: 'Newsletter',
  inSentence: 'the newsletter',
  icon: 'newsletter',
  defaultMode: 'off',
  group: 'blog',
  publishedBy: 'engine',
  idempotent: false,
  schedulable: true,
  pack: { key: 'newsletter', piece },
  brief:
    "newsletter: one issue per language ({{newsletterLanguages}}), each with a subject (at most {{limit.newsletterSubject}} characters), a preview text (at most {{limit.newsletterPreview}}) and a short Markdown body: a personal note to subscribers on what shipped and why it matters, linking the article in that language ({{site}}/<lang>/<that language's slug>/?ref=newsletter). Not the article itself; no images.",
  adapt: 'a personal note to subscribers in Markdown, short',
  draft: {
    file: (lang: string) => ({ name: `newsletter-${lang}.md`, title: `Newsletter (${lang})` }),
    match: (name: string) => DRAFT.exec(name)?.[1],
    read: (body: string) => {
      const issue = parseIssueDraft(body, { subject: '', previewText: '', markdown: '' });
      return { text: issue.markdown, title: issue.subject };
    },
  },
  editor: {
    format: 'light',
    marks: ['bold', 'italic', 'link'],
    blocks: ['bulletList', 'orderedList'],
    images: false,
    note: 'The issue styles bold, italics, links and lists; anything else reaches the inbox unstyled',
  },
  limits,
  edit: { edit: 'no', delete: 'no', note: 'A sent campaign is in the readers’ inboxes already', fields: [], main: 'post' },
  posting: {
    note: 'Tuesday and Thursday mornings, where the email send-time studies agree',
    windows: [
      { days: [1, 3], from: 9, to: 11, weight: 1 },
      { days: [2], from: 9, to: 11, weight: 0.8 },
      { days: WORKDAYS, from: 9, to: 11, weight: 0.6 },
      { days: MIDWEEK, from: 17, to: 19, weight: 0.5 },
    ],
  },
  metrics: { families: { views: ['opens'], clicks: ['clicks'], impressions: ['delivered'], unsubscribes: ['unsubscribes'] }, primary: ['opens', 'clicks'], cadence: QUARTER_HOUR_BATCHED },
  chartSlot: 6,
} as const satisfies ChannelDefinition<'newsletter'>;
