import { HOURLY_BATCHED, WEEKEND, WORKDAYS, type ChannelDefinition, type PieceKit } from './definition.ts';
import { parseInstagramDraft, singleDraft } from './text.ts';

const limits = {
  instagramCaption: 2200,
  instagramHashtags: 5,
  instagramSummary: 140,
  instagramSlideTitle: 40,
  instagramSlideText: 140,
} as const;

const URL_PATTERN = /https?:\/\/\S+/i;

const piece = ({ z }: PieceKit) =>
  z
    .strictObject({
      caption: z
        .string()
        .min(1)
        .max(limits.instagramCaption)
        .refine((c) => !URL_PATTERN.test(c), 'links in an Instagram caption are not clickable: point to the link in bio')
        .refine((c) => (c.match(/#[\p{L}\p{N}_]+/gu) ?? []).length <= limits.instagramHashtags, `at most ${limits.instagramHashtags} hashtags`),
      summary: z
        .string()
        .min(1)
        .max(limits.instagramSummary)
        .describe("One line under the cover's headline: what the project is, for someone scrolling past"),
      slides: z
        .array(
          z.strictObject({
            title: z.string().min(1).max(limits.instagramSlideTitle).describe('A few words: one thing the project does'),
            text: z.string().min(1).max(limits.instagramSlideText).describe('One sentence on it, concrete'),
          }),
        )
        .min(2)
        .max(3)
        .describe('The carousel slides between the cover (and demo) and the closing one: one implemented feature each'),
    })
    .describe('A carousel: the cover, the demo as a video when there is one, these slides, and a closing slide pointing to the link in bio')
    .optional();

export const instagram = {
  id: 'instagram',
  name: 'Instagram',
  inSentence: 'Instagram',
  icon: 'instagram',
  defaultMode: 'approval',
  group: 'social',
  publishedBy: 'engine',
  idempotent: false,
  schedulable: true,
  pack: { key: 'instagram', piece, postText: (p: { caption: string }) => p.caption },
  brief:
    'instagram: a carousel in English{{demoNote}}. A summary of one line for the cover (at most {{limit.instagramSummary}} characters); 2 or 3 slides, each one implemented feature with a short title (at most {{limit.instagramSlideTitle}} characters) and one concrete sentence (at most {{limit.instagramSlideText}}); and a short caption: a one-line hook, two or three lines on what it is, "link in bio" (links are not clickable there, so no URL), and at most {{limit.instagramHashtags}} specific hashtags, never generic ones.',
  adapt: `a caption of at most ${limits.instagramCaption} characters: a one-line hook, two or three lines, "link in bio", at most ${limits.instagramHashtags} specific hashtags`,
  // The carousel's texts are drawn into its images: only the caption is the post's text
  draft: { ...singleDraft('instagram', 'Instagram'), read: (body: string) => ({ text: parseInstagramDraft(body).caption }) },
  limits,
  edit: {
    edit: 'no',
    delete: 'no',
    note: 'Instagram’s API changes no caption of a published post and deletes no post; that is done in the app',
    fields: [],
    main: 'post',
  },
  comments: { read: true, reply: true, note: 'Needs the instagram_business_manage_comments permission on the connected account', replyLimit: 300 },
  profile: {
    read: false,
    edit: 'no',
    fields: ['displayName', 'bio', 'links', 'avatar'],
    editable: [],
    limits: { displayName: 30, bio: 150, links: { count: 5, name: 30, value: 2000 } },
    note: 'Instagram’s API gives neither the bio nor a way to change it: paste the bio to review it, then copy a proposal into the app',
  },
  posting: {
    note: 'weekday evenings and lunchtime, the hours the studies find for Instagram',
    windows: [
      { days: WORKDAYS, from: 18, to: 21, weight: 1 },
      { days: WORKDAYS, from: 12, to: 14, weight: 0.8 },
      { days: WEEKEND, from: 10, to: 13, weight: 0.6 },
      { days: WEEKEND, from: 19, to: 21, weight: 0.6 },
    ],
  },
  metrics: {
    families: { views: ['views'], reactions: ['likes'], comments: ['comments'], shares: ['shares'], impressions: ['reach'] },
    primary: ['views', 'likes'],
    cadence: HOURLY_BATCHED,
  },
  chartSlot: 2,
} as const satisfies ChannelDefinition<'instagram'>;
