import { MIDWEEK, WEEKEND, WORKDAYS, type ChannelDefinition, type PieceKit } from './definition.ts';
import { characters, singleDraft } from './text.ts';

const limits = { mastodonCharacters: 500 } as const;

const piece = ({ z, Language }: PieceKit) =>
  z
    .strictObject({
      lang: Language,
      text: z.string().min(1).max(limits.mastodonCharacters),
    })
    .optional();

export const mastodon = {
  id: 'mastodon',
  name: 'Mastodon',
  inSentence: 'Mastodon',
  icon: 'mastodon',
  defaultMode: 'approval',
  group: 'social',
  publishedBy: 'engine',
  // Mastodon takes the idempotency key: a status sent twice with it is posted once
  idempotent: true,
  schedulable: true,
  pack: { key: 'mastodon', piece, postText: (p: { text: string }) => p.text },
  brief:
    "mastodon: one post in English, at most {{limit.mastodonCharacters}} characters, ending with the English article's link {{site}}/en/<English slug>/?ref=mastodon, and a few hashtags (Mastodon search relies on them).",
  adapt: `at most ${limits.mastodonCharacters} characters, a few hashtags, a link at the end`,
  draft: { ...singleDraft('mastodon', 'Mastodon'), read: (body: string) => ({ text: body }) },
  limits,
  text: { max: limits.mastodonCharacters, length: characters, counting: 'the link and hashtags included' },
  edit: {
    edit: 'yes',
    delete: 'yes',
    note: 'An edit keeps the post’s replies and boosts, and Mastodon shows it as edited',
    fields: ['text', 'link', 'image'],
    main: 'post',
    linkAfterText: true,
  },
  // Mastodon counts the mention added in front of the text, so the draft leaves room for it
  comments: { read: true, reply: true, note: 'The public and unlisted replies under the status; a reply mentions the author so they are notified', replyLimit: 400 },
  profile: {
    read: true,
    edit: 'yes',
    fields: ['displayName', 'bio', 'links', 'avatar'],
    editable: ['displayName', 'bio', 'links'],
    limits: { displayName: 30, bio: 500, links: { count: 4, name: 255, value: 255 } },
    note: 'Through update_credentials, which needs write:accounts; an instance may allow a longer bio or more fields than these defaults',
  },
  posting: {
    note: 'midweek mornings in Europe, where most of the fediverse’s developers are',
    windows: [
      { days: MIDWEEK, from: 9, to: 12, weight: 1 },
      { days: WORKDAYS, from: 9, to: 12, weight: 0.8 },
      { days: WORKDAYS, from: 13, to: 15, weight: 0.6 },
      { days: WORKDAYS, from: 18, to: 21, weight: 0.6 },
      { days: WEEKEND, from: 10, to: 13, weight: 0.35 },
    ],
  },
  metrics: { families: { reactions: ['favourites'], comments: ['replies'], shares: ['boosts'] }, primary: ['favourites', 'boosts'] },
  chartSlot: 1,
} as const satisfies ChannelDefinition<'mastodon'>;
