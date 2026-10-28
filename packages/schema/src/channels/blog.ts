import { HOURLY_BATCHED, type ChannelDefinition, type PieceKit } from './definition.ts';

const limits = { articleDescription: 200, imageAlt: 140 } as const;

function piece({ z }: PieceKit) {
  const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'a slug is lowercase words joined by hyphens');
  const version = z.strictObject({
    slug: slug.describe("The article's path in this language, in this language's words: claudio-claude-code-as-a-service, claudio-claude-code-como-servicio"),
    title: z.string().min(1).max(120),
    description: z
      .string()
      .min(1)
      .max(limits.articleDescription)
      .describe('One or two sentences for the index, the meta description and the RSS feed'),
    markdown: z
      .string()
      .min(1)
      .describe(
        'The article body in Markdown, without front matter and without a top-level heading. It opens with one or two sentences that say plainly what the project is and what it does, the answer a search engine or an assistant quotes. For a launch: the problem, the solution, how it works, a quick start and next steps, with headings phrased as the questions a reader asks where that reads naturally ("How do I install it?").',
      ),
    imageAlt: z
      .string()
      .min(1)
      .max(limits.imageAlt)
      .optional()
      .describe("The launch image's alternative text in this language: what the image shows (the project's name, what it does), for people who cannot see it and for search"),
  });
  return z
    .strictObject({
      tags: z.array(z.string().min(1)).max(8).default([]),
      en: version.optional(),
      es: version.optional(),
    })
    .refine((a) => a.en || a.es, 'the article needs at least one language')
    .optional()
    .describe("The blog article, the launch's canonical page; one version per language the brand's blog uses");
}

/** The blog, in the launches repo: the launch's canonical page, published by merging the drafts */
export const blog = {
  id: 'blog',
  name: 'Blog',
  inSentence: 'the blog',
  icon: 'blog',
  defaultMode: 'approval',
  group: 'blog',
  publishedBy: 'merge',
  idempotent: false,
  schedulable: false,
  pack: { key: 'article', piece },
  brief:
    "article: the canonical post, one version per language ({{blogLanguages}}). Each version has its own slug, written in its language's words (the English one in English, the Spanish one in Spanish), and lives at {{site}}/<lang>/<that slug>/. Markdown body without front matter and without a top-level heading. Description at most {{limit.articleDescription}} characters. For search engines and assistants: the body's first paragraph says in one or two plain sentences what the project is and does; headings are phrased as the questions a reader asks where that reads naturally; imageAlt describes the launch image in that language (at most {{limit.imageAlt}} characters).",
  limits,
  edit: {
    edit: 'yes',
    delete: 'yes',
    note: 'By a commit to the launches repo, which deploys the site: an edit rewrites the article and sets its updatedDate; a delete removes it, and its media once no other language of the launch is left',
    fields: ['text', 'title', 'tags'],
    main: 'article:*',
    article: true,
    fieldNames: { text: 'the whole article body', link: 'the canonical URL', image: 'the cover' },
  },
  // Read for the launch as a whole (a site source), not per piece: no row leads with it
  // Cloudflare Web Analytics' page views of the article's paths, one grouped query for every path
  metrics: { families: { views: ['views'] }, primary: [], cadence: HOURLY_BATCHED },
  chartSlot: 5,
} as const satisfies ChannelDefinition<'blog'>;
