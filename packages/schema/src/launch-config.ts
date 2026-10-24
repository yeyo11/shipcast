import { z } from 'zod';
import { CHANNELS, DEFAULT_MODES, DRAFT_ONLY_CHANNELS, Language, PublishMode, type Channel } from './channels.ts';
import { parseYaml, type ParseResult } from './yaml.ts';

/** The content packs of the plan: a new project, a major version, everything else. */
export const PackKind = z.enum(['launch', 'major', 'minor']);
export type PackKind = z.infer<typeof PackKind>;

const publishingShape = Object.fromEntries(
  CHANNELS.map((channel) => [channel, PublishMode.default(DEFAULT_MODES[channel])]),
) as { [K in Channel]: z.ZodDefault<typeof PublishMode> };

const Publishing = z.strictObject(publishingShape).superRefine((modes, ctx) => {
  for (const channel of DRAFT_ONLY_CHANNELS) {
    const mode = modes[channel];
    if (mode !== 'manual' && mode !== 'off') {
      ctx.addIssue({
        code: 'custom',
        path: [channel],
        message: `${channel} is always a draft for you to post: use manual or off, not ${mode}`,
      });
    }
  }
});

/**
 * `.github/launch.yml` in a project: whether and how Shipcast launches it. Strict objects, so a
 * misspelt key is an error with its line rather than a setting silently ignored.
 */
export const LaunchConfig = z.strictObject({
  /** Required, so turning launches on is always a deliberate line in the file */
  enabled: z.boolean(),
  /** The `id` of the brand that speaks for the project; it must match the launches repo's brand.yml */
  brand: z.string().regex(/^[a-z0-9-]+$/, 'a brand id is lowercase letters, digits and hyphens'),
  /** The project's main language, for the channels whose language the brand does not set */
  language: Language.default('en'),
  /** Forces a content pack; inferred from the version when absent (see resolvePack) */
  pack: PackKind.optional(),
  triggers: z
    .strictObject({
      release: z.boolean().default(true),
      manual: z.boolean().default(true),
      /** The repo going from private to public */
      public: z.boolean().default(false),
      /** `enabled: true` landing in a repo that never launched, to announce older projects */
      enabled: z.boolean().default(false),
    })
    .prefault({}),
  content: z
    .strictObject({
      article: z.boolean().default(true),
      socialPosts: z.boolean().default(true),
      technicalTutorial: z.boolean().default(false),
    })
    .prefault({}),
  publishing: Publishing.prefault({}),
  assets: z
    .strictObject({
      /** Path in the repo or URL of the demo GIF; every launch needs one, as the plan decides */
      demo: z.string().min(1).optional(),
    })
    .prefault({}),
  reddit: z
    .strictObject({
      /** Names without the r/ prefix */
      subreddits: z.array(z.string().regex(/^[A-Za-z0-9_]{2,21}$/, 'a subreddit name, without r/')).default([]),
    })
    .prefault({}),
});

export type LaunchConfig = z.infer<typeof LaunchConfig>;

export function parseLaunchConfig(text: string): ParseResult<LaunchConfig> {
  return parseYaml(text, LaunchConfig);
}

/** The channels a launch generates something for, in the order of CHANNELS. */
export function activeChannels(config: LaunchConfig): Channel[] {
  return CHANNELS.filter((channel) => config.publishing[channel] !== 'off');
}
