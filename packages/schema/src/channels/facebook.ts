import { WEEKEND, WORKDAYS, type ChannelDefinition, type PieceKit } from './definition.ts';
import { PLAIN_TEXT } from './format.ts';
import { characters, singleDraft } from './text.ts';

/** A Page post takes far more, but one read past the fold is read by few; 2000 keeps it a post, not an article */
const limits = { facebookText: 2000 } as const;

const piece = ({ z }: PieceKit) =>
  z
    .strictObject({ text: z.string().min(1).max(limits.facebookText, `at most ${limits.facebookText} characters`) })
    .optional()
    .describe("One post on the owner's Facebook Page, sharing the article as its link card");

export const facebook = {
  id: 'facebook',
  name: 'Facebook',
  inSentence: 'Facebook',
  icon: 'facebook',
  defaultMode: 'off',
  group: 'social',
  publishedBy: 'engine',
  idempotent: false,
  schedulable: true,
  pack: { key: 'facebook', piece, postText: (p: { text: string }) => p.text },
  brief:
    "facebook: one post in {{facebookLanguage}} on the author's Facebook Page, at most {{limit.facebookText}} characters, the first line carrying the point (Facebook folds the rest). No link in the text: the article is attached as the post's link card. At most three hashtags.",
  adapt: 'a short post, the first line carrying the point, at most three hashtags',
  draft: { ...singleDraft('facebook', 'Facebook'), read: (body: string) => ({ text: body }) },
  editor: PLAIN_TEXT('Facebook'),
  limits,
  text: { max: limits.facebookText, length: characters, counting: 'the hashtags included' },
  edit: { edit: 'yes', delete: 'yes', note: 'A Page post can be edited in place and deleted', fields: ['text'], main: 'post' },
  comments: { read: true, reply: true, note: 'Every comment on the Page post; a reply is a comment under it', replyLimit: 8000 },
  profile: {
    read: true,
    edit: 'no',
    fields: ['bio', 'avatar'],
    editable: [],
    limits: {},
    note: 'Shipcast reads the Page’s About text and picture; change them on Facebook',
  },
  posting: {
    note: 'weekday mornings and early afternoon, the hours the studies find for Facebook Pages',
    windows: [
      { days: WORKDAYS, from: 9, to: 11, weight: 1 },
      { days: WORKDAYS, from: 13, to: 15, weight: 0.8 },
      { days: WEEKEND, from: 10, to: 12, weight: 0.4 },
    ],
  },
  metrics: {
    families: { views: ['views'], reactions: ['reactions'], comments: ['comments'], shares: ['shares'], clicks: ['clicks'] },
    primary: ['views', 'reactions'],
    cadence: { hours: 1, read: 'single', why: 'changes within the hour; one post a call' },
  },
} as const satisfies ChannelDefinition<'facebook'>;
