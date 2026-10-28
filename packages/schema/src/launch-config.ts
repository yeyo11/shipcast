import { z } from 'zod';
import { Language, PublishMode, type Channel } from './channels.ts';
import { CHANNELS, DEFAULT_MODES } from './channels/registry.ts';
import { parseYaml, type ParseResult } from './yaml.ts';

/** The content packs of the plan: a new project, a major version, everything else. */
export const PackKind = z.enum(['launch', 'major', 'minor']);
export type PackKind = z.infer<typeof PackKind>;

const publishingShape = Object.fromEntries(
  CHANNELS.map((channel) => [channel, PublishMode.default(DEFAULT_MODES[channel])]),
) as { [K in Channel]: z.ZodDefault<typeof PublishMode> };

const Publishing = z.strictObject(publishingShape);

export const MAX_TOUR_STEPS = 12;
export const MAX_SCREENSHOTS = 6;

/** A path on the site: it cannot leave it, so no scheme and no `//host` */
const SitePath = z.string().regex(/^\/(?!\/)[^\s]*$/, 'a path on the site, starting with a single /');

/** One thing to do while the tour is recorded; scrolls are relative, in pixels, or `bottom` */
export const TourStep = z.union([
  z.strictObject({ scroll: z.union([z.number().int().min(-20000).max(20000), z.literal('bottom')]) }),
  z.strictObject({ click: z.string().min(1) }),
  z.strictObject({ wait: z.number().int().min(100).max(5000) }),
  z.strictObject({ goto: SitePath }),
]);
export type TourStep = z.infer<typeof TourStep>;

export const ScreenshotPage = z.strictObject({
  path: SitePath,
  /** The file name stem; derived from the path when absent */
  name: z.string().regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and hyphens').optional(),
});
export type ScreenshotPage = z.infer<typeof ScreenshotPage>;

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
      /** The deployed project: Shipcast screenshots it and, with no `demo`, records a tour of it as the demo */
      site: z.url({ protocol: /^https$/, error: 'the deployed project, an https URL' }).optional(),
      /** What to do on the site while recording; a short scroll down and back when absent */
      tour: z.array(TourStep).max(MAX_TOUR_STEPS, `a tour has at most ${MAX_TOUR_STEPS} steps`).optional(),
      /** The pages to capture, desktop and mobile each; the site's root when absent */
      screenshots: z.array(ScreenshotPage).min(1).max(MAX_SCREENSHOTS, `at most ${MAX_SCREENSHOTS} screenshot pages`).optional(),
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

/** Whether the launch has a demo: a committed one, or one to record from the deployed project. */
export function hasDemo(config: LaunchConfig): boolean {
  return Boolean(config.assets.demo ?? config.assets.site);
}
