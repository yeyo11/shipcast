import { isMap, isScalar, parseDocument } from 'yaml';
import { CHANNELS, ContentPack, parseLaunchConfig, PublishMode, type LaunchConfig } from '@shipcast/schema';
import { channelsAsLaunchYml, MAIN_PIECE } from './launch-store.ts';
import type { ChannelRow } from './repositories/index.ts';

/*
 * How the rows of a launch decided in a pull request read today: the mapping the import of those
 * launches used (docs/launch-import.md; its script is removed), kept for the rows it wrote, which
 * the launch page, the review and publishing still read.
 */

/** Moved to launch-keys.ts, which core detection imports without the import's dependencies; re-exported for its callers */
export { dedupeKeyOf } from './launch-keys.ts';

/**
 * A launch.yml read as today's schema reads it, even one written before a channel or a mode was
 * retired (v0.1.0's `hackerNews: manual`, docs/decisions/automatic-channels-only.md): a `publishing`
 * entry today's schema does not know is dropped and named, the rest parsed as it is. Undefined when
 * the file does not parse even so.
 */
export function readLaunchYml(text: string): { config: LaunchConfig; dropped: string[] } | undefined {
  const parsed = parseLaunchConfig(text);
  if (parsed.ok) return { config: parsed.value, dropped: [] };
  const doc = parseDocument(text);
  const publishing = doc.get('publishing', true);
  const dropped: string[] = [];
  if (isMap(publishing)) {
    for (const item of [...publishing.items]) {
      const channel = String(isScalar(item.key) ? item.key.value : item.key);
      const mode = String(isScalar(item.value) ? item.value.value : item.value);
      if ((CHANNELS as readonly string[]).includes(channel) && PublishMode.safeParse(mode).success) continue;
      dropped.push(`${channel}: ${mode}`);
      publishing.delete(item.key);
    }
  }
  const again = dropped.length > 0 ? parseLaunchConfig(String(doc)) : parsed;
  return again.ok ? { config: again.value, dropped } : undefined;
}

/**
 * The channels a launch the launch model holds publishes on, as launch.yml says them: the one copied
 * when it was drafted, each channel's mode from its row (the import turned off the channels that
 * never published). Undefined when no channels were stored, or they do not parse.
 */
export function storedChannelConfig(channels: { rows: readonly ChannelRow[]; source: string | null }): LaunchConfig | undefined {
  if (channels.source === null) return undefined;
  return readLaunchYml(channels.rows.length > 0 ? channelsAsLaunchYml(channels.source, channels.rows) : channels.source)?.config;
}

/**
 * A pack read as today's schema reads it: a pack written before a channel was retired (v0.1.0's
 * `hackerNews` and `productHunt`) is refused whole by the strict schema, so the keys it refuses at
 * the top are dropped and named. The stored pack keeps them; this is for running today's code on it.
 */
export function readPack(pack: Record<string, unknown>): { pack: Record<string, unknown>; dropped: string[] } {
  const parsed = ContentPack.safeParse(pack);
  if (parsed.success) return { pack, dropped: [] };
  const dropped = parsed.error.issues.flatMap((issue) => (issue.code === 'unrecognized_keys' && issue.path.length === 0 ? issue.keys : []));
  return { pack: Object.fromEntries(Object.entries(pack).filter(([key]) => !dropped.includes(key))), dropped };
}

/**
 * The draft a published piece came from, among the launch's: the piece of the same name (`article:en`),
 * the part after the kind's colon (a newsletter's `issue:es` is the `es` draft, a subreddit's post its
 * subreddit's), or the channel's one draft (an Instagram story and comment come from its post's).
 */
export function draftOfPiece(channel: string, kind: string, drafts: ReadonlyArray<{ channel: string; piece: string }>): string | undefined {
  const own = drafts.filter((d) => d.channel === channel).map((d) => d.piece);
  const part = kind.includes(':') ? kind.slice(kind.indexOf(':') + 1) : undefined;
  return [kind, part, MAIN_PIECE].find((p) => p !== undefined && own.includes(p)) ?? (own.length === 1 ? own[0] : undefined);
}
