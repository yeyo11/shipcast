import { WEEKEND, WORKDAYS, type ChannelDefinition, type PieceKit } from './definition.ts';
import { characters, singleDraft } from './text.ts';

/** Fits a photo caption (1024) with room for the link */
const limits = { telegramText: 900 } as const;

const piece = ({ z }: PieceKit) =>
  z
    .strictObject({ text: z.string().min(1).max(limits.telegramText) })
    .optional()
    .describe('One post in English that goes under the launch image');

export const telegram = {
  id: 'telegram',
  name: 'Telegram',
  inSentence: 'Telegram',
  icon: 'telegram',
  defaultMode: 'off',
  group: 'social',
  publishedBy: 'engine',
  idempotent: false,
  schedulable: true,
  pack: { key: 'telegram', piece },
  brief: "telegram: one post in English, at most {{limit.telegramText}} characters (it is the caption of the launch image), ending with the English article's link {{site}}/en/<English slug>/?ref=telegram.",
  adapt: `at most ${limits.telegramText} characters, a link at the end`,
  draft: { ...singleDraft('telegram', 'Telegram'), read: (body: string) => ({ text: body }) },
  limits,
  text: { max: limits.telegramText, length: characters, counting: 'the link included' },
  edit: {
    edit: 'yes',
    delete: 'yes',
    note: 'The text, or the caption of a photo (with its photo); Telegram refuses to delete a message older than 48 hours',
    fields: ['text', 'link', 'image'],
    main: 'post',
    linkAfterText: true,
    // The Bot API cannot read the caption back, so a new photo needs its caption with it
    textRequired: true,
    fieldNames: { image: 'the photo' },
  },
  comments: { read: false, reply: false, note: 'A bot cannot read the replies to a channel post' },
  profile: {
    read: true,
    edit: 'yes',
    fields: ['displayName', 'bio', 'avatar'],
    editable: ['displayName', 'bio'],
    brandPicture: true,
    limits: { displayName: 128, bio: 255 },
    note: 'The channel’s title, description and photo; the bot needs the “Change channel info” admin right',
  },
  posting: {
    note: 'weekday late afternoons, after work, and late mornings',
    windows: [
      { days: WORKDAYS, from: 17, to: 20, weight: 1 },
      { days: WORKDAYS, from: 10, to: 13, weight: 0.8 },
      { days: WEEKEND, from: 11, to: 13, weight: 0.4 },
    ],
  },
  // Reactions only: the Bot API gives bots no views or forwards, and pushes reaction changes, kept 24 hours
  metrics: { families: { reactions: ['reactions'] }, primary: ['reactions'], cadence: { hours: 1, read: 'batched', why: 'pushed changes are kept 24 hours' } },
} as const satisfies ChannelDefinition<'telegram'>;
