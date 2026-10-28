import type { ChannelDefinition, PieceKit } from './definition.ts';
import { parseDiscussionDraft } from './text.ts';

const limits = { redditTitle: 300 } as const;

const piece = ({ z }: PieceKit) =>
  z
    .array(
      z.strictObject({
        subreddit: z.string().regex(/^[A-Za-z0-9_]{2,21}$/).describe("Without r/: one of launch.yml's, or one you suggest when it lists none"),
        title: z.string().min(1).max(limits.redditTitle),
        body: z.string().min(1).describe("Markdown, written for that community's rules: what you built and why, not an ad; it links the article"),
      }),
    )
    .optional()
    .describe('One text post per subreddit, linking the article');

const DRAFT = /^reddit-(.+)\.md$/;

/** Reddit: one text post per subreddit, each a draft of its own edited like a discussion */
export const reddit = {
  id: 'reddit',
  name: 'Reddit',
  inSentence: 'Reddit',
  icon: 'reddit',
  defaultMode: 'off',
  group: 'social',
  publishedBy: 'engine',
  // The connector looks for a submission whose answer was lost before it submits again
  idempotent: true,
  // Its launch is one post per subreddit, and a schedule is one row per channel
  schedulable: false,
  pack: { key: 'reddit', piece },
  brief:
    "reddit: {{redditTarget}}. Each is a text post with a title and a Markdown body, written for that community: what was built and why, plain and honest, never an ad, following what that subreddit allows. The body links the article with ?ref=reddit. Shipcast posts them from the owner's account.",
  adapt: 'a post for a developer community: what was built and why, plain and honest, never an ad',
  draft: {
    file: (subreddit: string) => ({ name: `reddit-${subreddit.toLowerCase()}.md`, title: `Reddit, r/${subreddit}` }),
    match: (name: string) => DRAFT.exec(name)?.[1],
    read: (body: string) => {
      const post = parseDiscussionDraft(body, { title: '', body: '' });
      return { text: post.body, title: post.title };
    },
  },
  limits,
  edit: {
    edit: 'no',
    delete: 'yes',
    note: 'Each subreddit’s post can be deleted; a Reddit title can never change, and editing the body is not built',
    fields: [],
    main: 'post:*',
  },
  profile: {
    read: false,
    edit: 'no',
    fields: ['displayName', 'bio', 'avatar'],
    editable: [],
    limits: { displayName: 30, bio: 200 },
    note: 'Shipcast’s Reddit scopes do not reach the profile: paste it to review it, then copy a proposal into Reddit',
  },
} as const satisfies ChannelDefinition<'reddit'>;
