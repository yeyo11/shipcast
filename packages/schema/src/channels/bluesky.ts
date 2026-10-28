import { MIDWEEK, WEEKEND, WORKDAYS, type ChannelDefinition, type PieceKit } from './definition.ts';
import { graphemeCount, singleDraft } from './text.ts';

const limits = { blueskyGraphemes: 300 } as const;

const piece = ({ z, Language }: PieceKit) =>
  z
    .strictObject({
      lang: Language,
      text: z
        .string()
        .min(1)
        .refine((t) => graphemeCount(t) <= limits.blueskyGraphemes, `at most ${limits.blueskyGraphemes} graphemes`),
    })
    .optional();

export const bluesky = {
  id: 'bluesky',
  name: 'Bluesky',
  inSentence: 'Bluesky',
  icon: 'bluesky',
  defaultMode: 'approval',
  group: 'social',
  publishedBy: 'engine',
  idempotent: false,
  schedulable: true,
  pack: { key: 'bluesky', piece, postText: (p: { text: string }) => p.text },
  brief: "bluesky: one post in English, at most {{limit.blueskyGraphemes}} characters, ending with the English article's link {{site}}/en/<English slug>/?ref=bluesky.",
  adapt: `at most ${limits.blueskyGraphemes} characters, a link at the end`,
  draft: { ...singleDraft('bluesky', 'Bluesky'), read: (body: string) => ({ text: body }) },
  limits,
  text: { max: limits.blueskyGraphemes, length: graphemeCount, counting: 'the link included' },
  edit: {
    edit: 'no',
    delete: 'yes',
    note: 'Bluesky has no edit: a post can only be deleted and posted again, which loses its likes and replies, so Shipcast never does that on its own',
    fields: [],
    main: 'post',
  },
  comments: { read: true, reply: true, note: 'The replies in the post’s thread, from the public AppView; a reply is threaded under the comment', replyLimit: 300, replyLength: graphemeCount },
  profile: {
    read: true,
    edit: 'yes',
    fields: ['displayName', 'bio', 'avatar'],
    editable: ['displayName', 'bio'],
    limits: { displayName: 64, bio: 256, graphemes: true },
    note: 'The profile record is written back whole, its picture, banner and the rest kept as they are',
  },
  posting: {
    note: 'weekday afternoons, when Europe’s afternoon meets the US east coast’s morning (Bluesky’s developers are mostly American)',
    windows: [
      { days: WORKDAYS, from: 15, to: 19, weight: 1 },
      { days: MIDWEEK, from: 9, to: 12, weight: 0.7 },
      { days: WORKDAYS, from: 9, to: 12, weight: 0.5 },
      { days: WEEKEND, from: 10, to: 13, weight: 0.3 },
    ],
  },
  metrics: { families: { reactions: ['likes'], comments: ['replies'], shares: ['reposts', 'quotes'] }, primary: ['likes', 'reposts'] },
  chartSlot: 0,
} as const satisfies ChannelDefinition<'bluesky'>;
