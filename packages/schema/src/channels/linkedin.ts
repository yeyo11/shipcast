import { MIDWEEK, WEEKEND, WORKDAYS, type ChannelDefinition, type PieceKit } from './definition.ts';
import { characters, singleDraft } from './text.ts';

/** LinkedIn takes 3000; a post past the "see more" fold at about 200 is read by fewer people */
const limits = { linkedinText: 1300 } as const;

const piece = ({ z }: PieceKit) =>
  z
    .strictObject({ text: z.string().min(1).max(limits.linkedinText) })
    .optional()
    .describe("One post in English on the owner's LinkedIn profile, sharing the article as its link card");

export const linkedin = {
  id: 'linkedin',
  name: 'LinkedIn',
  inSentence: 'LinkedIn',
  icon: 'linkedin',
  defaultMode: 'off',
  group: 'social',
  publishedBy: 'engine',
  idempotent: false,
  schedulable: true,
  pack: { key: 'linkedin', piece },
  brief:
    "linkedin: one post in {{linkedinLanguage}} on the author's own profile, at most {{limit.linkedinText}} characters, written for developers and engineering peers: the first two lines carry the point (LinkedIn folds the rest), then what it is, why it was built and what it does today, in short paragraphs. No link in the text: the article is attached as the post's link card. Up to three specific hashtags at the end.",
  adapt: 'a short professional post, a few short paragraphs, no hashtag walls',
  draft: { ...singleDraft('linkedin', 'LinkedIn'), read: (body: string) => ({ text: body }) },
  limits,
  text: { max: limits.linkedinText, length: characters, counting: 'the hashtags included' },
  edit: {
    edit: 'no',
    delete: 'yes',
    note: 'Published on the personal profile with Share on LinkedIn, which can delete; LinkedIn’s comments and numbers need its Community Management API, granted only to approved companies, so none are read',
    fields: [],
    main: 'post',
  },
  comments: { read: false, reply: false, note: 'Reading comments on a member’s post needs LinkedIn’s Community Management API, granted only to approved companies' },
  // The About section is pasted; the name and photo are read with the token (OpenID Connect's
  // userinfo) and fill what the paste leaves out
  profile: {
    read: false,
    readable: ['displayName', 'avatar'],
    edit: 'no',
    fields: ['displayName', 'bio', 'avatar'],
    editable: [],
    limits: { bio: 2600 },
    note: 'Shipcast reads your name and photo; paste the About section to review it, then copy a proposal. LinkedIn lets no app change a member’s profile',
  },
  posting: {
    note: 'Tuesday to Thursday mornings, where the LinkedIn studies agree',
    windows: [
      { days: MIDWEEK, from: 8, to: 11, weight: 1 },
      { days: WORKDAYS, from: 8, to: 11, weight: 0.7 },
      { days: MIDWEEK, from: 12, to: 14, weight: 0.6 },
      { days: WEEKEND, from: 10, to: 12, weight: 0.1 },
    ],
  },
} as const satisfies ChannelDefinition<'linkedin'>;
