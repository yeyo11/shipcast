import { MIDWEEK, WEEKEND, WORKDAYS, type ArticleSummary, type ChannelDefinition, type PieceKit } from './definition.ts';
import { singleDraft } from './text.ts';

const limits = { devtoTags: 4 } as const;

const piece = ({ z }: PieceKit) =>
  z
    .strictObject({
      tags: z
        .array(z.string().regex(/^[a-z0-9]+$/, 'dev.to tags are lowercase letters and digits'))
        .min(1)
        .max(limits.devtoTags),
    })
    .optional()
    .describe('dev.to republishes the English article with the blog as canonical URL; only its tags are its own');

/** dev.to: the English article again, with the blog as its canonical URL */
export const devto = {
  id: 'devto',
  name: 'dev.to',
  inSentence: 'dev.to',
  icon: 'devto',
  defaultMode: 'approval',
  group: 'blog',
  publishedBy: 'engine',
  idempotent: false,
  schedulable: true,
  pack: {
    key: 'devto',
    piece,
    // Its post is the article: a comment there answers the article's title and description
    postText: (_piece: unknown, article: ArticleSummary | undefined) => (article ? `${article.title}\n\n${article.description}` : undefined),
  },
  brief: 'devto: 1 to {{limit.devtoTags}} lowercase tags. dev.to republishes the English article with the blog as canonical URL, so write nothing else for it.',
  adapt: 'an article in Markdown for developers, plain and practical',
  draft: { ...singleDraft('devto', 'dev.to'), read: (body: string) => ({ text: body }) },
  limits,
  edit: {
    edit: 'yes',
    delete: 'unpublish',
    note: 'dev.to has no delete in its API: the article is unpublished and stays in the author’s dashboard',
    fields: ['text', 'title', 'tags', 'link', 'image'],
    main: 'post',
    article: true,
    fieldNames: { text: 'the whole article body', link: 'the canonical URL', image: 'the cover' },
  },
  comments: { read: true, reply: false, note: 'Forem’s API reads comments but cannot write one: the draft is copied and posted on dev.to', replyLimit: 600 },
  profile: {
    read: true,
    edit: 'no',
    fields: ['displayName', 'bio', 'links', 'avatar'],
    editable: [],
    limits: { bio: 200 },
    note: 'Forem’s API reads the profile but cannot change it: copy a proposal into dev.to’s settings',
  },
  posting: {
    note: 'midweek mornings, read with the first coffee in Europe and in the US feed by its morning',
    windows: [
      { days: MIDWEEK, from: 8, to: 11, weight: 1 },
      { days: WORKDAYS, from: 8, to: 11, weight: 0.7 },
      { days: [0, 1, 2, 3], from: 15, to: 17, weight: 0.6 },
      { days: WEEKEND, from: 10, to: 13, weight: 0.2 },
    ],
  },
  metrics: { families: { views: ['views'], reactions: ['reactions'], comments: ['comments'] }, primary: ['views', 'reactions'] },
  // dev.to's brand is black, which fails on the night page: it takes the text colour
  chartSlot: 'ink',
} as const satisfies ChannelDefinition<'devto'>;
