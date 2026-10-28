import { MIDWEEK, WEEKEND, WORKDAYS, type ChannelDefinition, type PieceKit } from './definition.ts';
import { singleDraft } from './text.ts';

const limits = { hashnodeTags: 5 } as const;

const piece = ({ z }: PieceKit) =>
  z
    .strictObject({
      tags: z
        .array(z.string().regex(/^[a-z0-9]+$/, 'Hashnode tags are lowercase letters and digits'))
        .min(1)
        .max(limits.hashnodeTags),
    })
    .optional()
    .describe('Hashnode republishes the English article with the blog as the original URL; only its tags are its own');

/** Hashnode: the English article again, with the blog as its original URL */
export const hashnode = {
  id: 'hashnode',
  name: 'Hashnode',
  inSentence: 'Hashnode',
  icon: 'hashnode',
  defaultMode: 'off',
  group: 'blog',
  publishedBy: 'engine',
  idempotent: false,
  schedulable: true,
  pack: { key: 'hashnode', piece },
  brief:
    'hashnode: 1 to {{limit.hashnodeTags}} lowercase tags (letters and digits only). Hashnode republishes the English article with the blog as the original URL, so write nothing else for it.',
  adapt: 'an article in Markdown for developers, plain and practical',
  draft: { ...singleDraft('hashnode', 'Hashnode'), read: (body: string) => ({ text: body }) },
  limits,
  edit: {
    edit: 'yes',
    delete: 'yes',
    note: 'Through updatePost and removePost; the API answers only publications on the Pro plan',
    fields: ['text', 'title', 'tags', 'link', 'image'],
    main: 'post',
    article: true,
    fieldNames: { text: 'the whole article body', link: 'the canonical URL', image: 'the cover' },
  },
  profile: {
    read: true,
    edit: 'no',
    fields: ['displayName', 'bio', 'links', 'avatar'],
    editable: [],
    limits: {},
    note: 'Hashnode’s API reads the profile but has no mutation for it: copy a proposal into Hashnode’s settings',
  },
  posting: {
    note: 'midweek mornings, as on dev.to',
    windows: [
      { days: MIDWEEK, from: 8, to: 11, weight: 1 },
      { days: WORKDAYS, from: 8, to: 11, weight: 0.7 },
      { days: [0, 1, 2, 3], from: 15, to: 17, weight: 0.6 },
      { days: WEEKEND, from: 10, to: 13, weight: 0.2 },
    ],
  },
  metrics: { families: { views: ['views'], reactions: ['reactions'], comments: ['comments'] }, primary: ['views', 'reactions'] },
  chartSlot: 4,
} as const satisfies ChannelDefinition<'hashnode'>;
