import { WEEKEND, WORKDAYS, type ChannelDefinition, type PieceKit } from './definition.ts';
import { singleDraft, threadsLength } from './text.ts';

const limits = { threadsText: 500 } as const;

const piece = ({ z }: PieceKit) =>
  z
    .strictObject({
      text: z
        .string()
        .min(1)
        .refine((t) => threadsLength(t) <= limits.threadsText, `at most ${limits.threadsText} characters, an emoji counting as its UTF-8 bytes`),
    })
    .optional()
    .describe('One Threads post in English that goes with the launch image, linking the article');

export const threads = {
  id: 'threads',
  name: 'Threads',
  inSentence: 'Threads',
  icon: 'threads',
  defaultMode: 'off',
  group: 'social',
  publishedBy: 'engine',
  idempotent: false,
  schedulable: true,
  pack: { key: 'threads', piece, postText: (p: { text: string }) => p.text },
  brief:
    "threads: one post in English, at most {{limit.threadsText}} characters (an emoji counts as four), conversational, ending with the English article's link {{site}}/en/<English slug>/?ref=threads. It goes with the launch image. At most two hashtags, or none.",
  adapt: `at most ${limits.threadsText} characters (an emoji counts as four), conversational, a link at the end, at most two hashtags`,
  draft: { ...singleDraft('threads', 'Threads'), read: (body: string) => ({ text: body }) },
  limits,
  text: { max: limits.threadsText, length: threadsLength, counting: 'the link included, an emoji counting as four or more' },
  edit: { edit: 'no', delete: 'yes', note: 'The Threads API has no edit: a post can only be deleted (at most 100 deletes a day)', fields: [], main: 'post' },
  comments: {
    read: true,
    reply: true,
    note: 'Every reply in the post’s conversation (threads_read_replies); a reply is a post under the comment (threads_manage_replies)',
    replyLimit: 400,
    replyLength: threadsLength,
  },
  profile: {
    read: false,
    edit: 'no',
    fields: ['bio', 'links', 'avatar'],
    editable: [],
    limits: { bio: 150, links: { count: 5, name: 30, value: 2000 } },
    note: 'The Threads API cannot change a profile: paste the bio to review it, then copy a proposal into the app',
  },
  posting: {
    note: 'weekday lunchtime and early evening, the hours the studies find for Threads, which share Instagram’s audience',
    windows: [
      { days: WORKDAYS, from: 12, to: 14, weight: 1 },
      { days: WORKDAYS, from: 18, to: 21, weight: 0.8 },
      { days: WEEKEND, from: 10, to: 13, weight: 0.4 },
    ],
  },
  // Views, likes, replies, reposts, quotes and shares, from the post's insights
  metrics: {
    families: { views: ['views'], reactions: ['likes'], comments: ['replies'], shares: ['reposts', 'quotes', 'shares'] },
    primary: ['views', 'likes'],
  },
} as const satisfies ChannelDefinition<'threads'>;
