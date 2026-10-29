import { WEEKEND, WORKDAYS, type ChannelDefinition, type PieceKit } from './definition.ts';
import { characters, singleDraft } from './text.ts';

const limits = { discordText: 1800 } as const;

const piece = ({ z }: PieceKit) =>
  z
    .strictObject({ text: z.string().min(1).max(limits.discordText) })
    .optional()
    .describe('One message in English');

export const discord = {
  id: 'discord',
  name: 'Discord',
  inSentence: 'Discord',
  icon: 'discord',
  defaultMode: 'off',
  group: 'social',
  publishedBy: 'engine',
  idempotent: false,
  schedulable: true,
  pack: { key: 'discord', piece },
  brief: "discord: one message in English, at most {{limit.discordText}} characters, ending with the English article's link {{site}}/en/<English slug>/?ref=discord. Short paragraphs; Discord renders Markdown.",
  adapt: `at most ${limits.discordText} characters, short paragraphs, Markdown`,
  draft: { ...singleDraft('discord', 'Discord'), read: (body: string) => ({ text: body }) },
  limits,
  text: { max: limits.discordText, length: characters, counting: 'the link included' },
  edit: {
    edit: 'yes',
    delete: 'yes',
    note: 'Through the webhook that sent the message',
    fields: ['text', 'link'],
    main: 'post',
    linkAfterText: true,
    textRequired: true,
    fieldNames: { text: 'the message' },
  },
  comments: { read: false, reply: false, note: 'A webhook cannot read the replies to its message' },
  profile: {
    read: true,
    edit: 'yes',
    fields: ['displayName', 'avatar'],
    editable: ['displayName'],
    brandPicture: true,
    limits: { displayName: 80 },
    note: 'The webhook’s name and picture, which every message shows as its author; the server’s own profile needs a bot',
  },
  posting: {
    note: 'weekday late afternoons, when the servers are busiest, and late mornings',
    windows: [
      { days: WORKDAYS, from: 17, to: 20, weight: 1 },
      { days: WORKDAYS, from: 10, to: 13, weight: 0.8 },
      { days: WEEKEND, from: 11, to: 13, weight: 0.4 },
    ],
  },
  // Reactions only: Discord counts no views, and the replies need a bot
  metrics: { families: { reactions: ['reactions'] }, primary: ['reactions'], cadence: { hours: 1, read: 'single', why: 'changes within the hour; one message a call' } },
} as const satisfies ChannelDefinition<'discord'>;
