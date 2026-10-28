import { HOURLY_BATCHED, WEEKEND, WORKDAYS, type ChannelDefinition, type PieceKit } from './definition.ts';
import { parseDiscussionDraft, singleDraft } from './text.ts';

const limits = {
  /** GitHub takes longer titles; a discussion list shows about this much */
  githubDiscussionTitle: 120,
  githubDiscussionBody: 4000,
} as const;

const piece = ({ z }: PieceKit) =>
  z
    .strictObject({
      title: z.string().min(1).max(limits.githubDiscussionTitle),
      body: z
        .string()
        .min(1)
        .max(limits.githubDiscussionBody)
        .describe('Markdown, in English, for the people who watch the repository: what shipped and how to try it, linking the article'),
    })
    .optional()
    .describe("An announcement in the launched repo's Discussions (the Announcements category, else General)");

/** An announcement in the launched repo's Discussions, posted by the GitHub App: nothing to connect */
export const githubDiscussions = {
  id: 'githubDiscussions',
  name: 'GitHub Discussions',
  inSentence: 'GitHub Discussions',
  icon: 'github',
  // Nothing to connect: the GitHub App posts it, so it is on like the MVP's channels
  defaultMode: 'approval',
  group: 'social',
  publishedBy: 'engine',
  idempotent: false,
  schedulable: true,
  pack: { key: 'githubDiscussions', piece, postText: (p: { title: string; body: string }) => `${p.title}\n\n${p.body}` },
  brief:
    "githubDiscussions: an announcement in the repository's Discussions, in English, for the people who watch the repository. A plain title (at most {{limit.githubDiscussionTitle}} characters, the project's name and what shipped) and a Markdown body (at most {{limit.githubDiscussionBody}} characters): what shipped in two or three short paragraphs, how to install or try it with the repository's real commands, and the English article's link {{site}}/en/<English slug>/?ref=github. It invites feedback in the thread; no hype, no hashtags.",
  adapt: `an announcement for the people who watch the repository: a plain title of at most ${limits.githubDiscussionTitle} characters, then what shipped and how to try it in Markdown; no hype, no hashtags`,
  // The title has a line of its own above the body: it is the edit form's title, never its text
  draft: {
    ...singleDraft('github-discussion', 'GitHub Discussions'),
    read: (body: string) => {
      const discussion = parseDiscussionDraft(body, { title: '', body: '' });
      return { text: discussion.body, title: discussion.title };
    },
  },
  limits,
  edit: {
    edit: 'yes',
    delete: 'yes',
    note: 'Through the GitHub App: an edit replaces the title or the Markdown body (GitHub shows it as edited); a delete removes the discussion with its comments',
    fields: ['text', 'title'],
    main: 'post',
  },
  comments: {
    read: true,
    reply: true,
    note: 'The comments and their replies, through the GitHub App; a reply is written by the App’s bot, not by your own GitHub account',
    replyLimit: 1000,
  },
  posting: {
    note: 'weekday working hours in Europe and the US east coast, when maintainers and watchers read GitHub',
    windows: [
      { days: WORKDAYS, from: 15, to: 18, weight: 1 },
      { days: WORKDAYS, from: 9, to: 13, weight: 0.8 },
      { days: WEEKEND, from: 10, to: 13, weight: 0.3 },
    ],
  },
  // The discussion counts them itself: its reactions and upvotes, and its comments
  metrics: { families: { reactions: ['reactions', 'upvotes'], comments: ['comments'] }, primary: ['reactions', 'comments'], cadence: HOURLY_BATCHED },
} as const satisfies ChannelDefinition<'githubDiscussions'>;
