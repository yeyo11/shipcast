import { z } from 'zod';
import { Language } from './channels.ts';
import { parseYaml, type ParseResult } from './yaml.ts';

/** The networks a brand can have a profile on. */
export const NETWORKS = ['x', 'linkedin', 'bluesky', 'mastodon', 'devto', 'reddit', 'instagram', 'hashnode'] as const;
export type Network = (typeof NETWORKS)[number];

const profileUrl = z.url({ protocol: /^https$/, error: 'a profile is its full https:// URL' });

const handlesShape = Object.fromEntries(NETWORKS.map((network) => [network, profileUrl.optional()])) as {
  [K in Network]: z.ZodOptional<typeof profileUrl>;
};

/**
 * `brand.yml` at the root of a brand's launches repo (docs/brands.md): who the launches speak for.
 * Public information only; the tokens to post as this brand live in Shipcast's .env.
 */
export const Brand = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/, 'a brand id is lowercase letters, digits and hyphens'),
  displayName: z.string().min(1),
  /** The GitHub account whose repos speak for this brand */
  github: z.string().regex(/^[A-Za-z0-9-]+$/, 'a GitHub login, without the URL'),
  /** A channel without a handle cannot publish */
  handles: z.strictObject(handlesShape).prefault({}),
  languages: z
    .strictObject({
      blog: z.array(Language).min(1).default(['en', 'es']),
      // Only for brands that publish there; the personal brand does not use X or LinkedIn
      x: Language.optional(),
      linkedin: Language.optional(),
    })
    .prefault({}),
  /** How the AI writes for this brand; empty until it is defined from examples (phase 5) */
  tone: z.string().default(''),
  /** Where readers can support the author */
  support: z.url().optional(),
  /** Visit counting on the brand's site; tokens here are public, they ship in every page */
  analytics: z
    .strictObject({
      cloudflareWebAnalytics: z
        .string()
        .regex(/^[0-9a-f]{32}$/, 'a Cloudflare Web Analytics site token: 32 hexadecimal characters')
        .optional(),
    })
    .prefault({}),
});

export type Brand = z.infer<typeof Brand>;

export function parseBrand(text: string): ParseResult<Brand> {
  return parseYaml(text, Brand);
}
