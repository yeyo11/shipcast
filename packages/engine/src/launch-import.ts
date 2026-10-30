import { createHash } from 'node:crypto';
import { isMap, isScalar, parseDocument } from 'yaml';
import { CHANNELS, ContentPack, parseLaunchConfig, PublishMode, type LaunchConfig } from '@shipcast/schema';
import { isArticle } from './drafts.ts';
import { channelsAsLaunchYml, MAIN_PIECE } from './launch-store.ts';
import type { ChannelRow, Launch } from './repositories/index.ts';

/*
 * The pure part of the import of the launches drafted before Shipcast held them (docs/launch-import.md):
 * how a launch, its published pieces and the owner's input map onto the launch model's rows. The
 * files themselves map through the shadow write's `storedFile`, so both read a pull request alike.
 */

/** Why a channel the import turned off is off: nothing of it was ever published, so nothing old goes out now */
export const NOT_PUBLISHED = 'not published before the import';

/** The git blob hash of a file's bytes, which a commit's tree lists: a copy is checked against the commit without reading the file again */
export function gitBlobSha(content: Uint8Array | string): string {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

/**
 * What "a launch happens once" is checked on once there is no repo and tag to claim
 * (`launches.dedupe_key`): the release a launch announced, the repo that went public, the article.
 */
export function dedupeKeyOf(launch: Pick<Launch, 'repo' | 'ref'>): string {
  if (isArticle(launch)) return `article:${launch.ref.slice('article:'.length)}`;
  if (launch.ref.startsWith('public:')) return `github-public:${launch.repo}`;
  return `github-release:${launch.repo}@${launch.ref}`;
}

/**
 * The launch's channel rows as imported: a channel that was on but never published anything (a
 * piece of any status) is turned off, so re-running the launch, or a retry, can never send a draft
 * of weeks ago. A channel off stays off; one with pieces keeps its mode.
 */
export function importedChannels(rows: readonly ChannelRow[], published: ReadonlySet<string>): { rows: ChannelRow[]; turnedOff: string[] } {
  const turnedOff: string[] = [];
  const out = rows.map((row) => {
    if (row.mode === 'off' || published.has(row.channel)) return row;
    turnedOff.push(row.channel);
    return { ...row, mode: 'off', note: NOT_PUBLISHED };
  });
  return { rows: out, turnedOff };
}

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

/** The owner's input to an article launch, as the job that drafted it carried it */
export interface CapturedArticleInput {
  launchId: number;
  input: { title?: string; lang?: string; markdown?: string; channels?: string[] };
}

/**
 * The article inputs of a capture, one job per line: pg-boss's `{ launchId, input }` or a BullMQ job's
 * `{ data: { launchId, input } }`. A line that is neither is reported rather than skipped.
 */
export function parseArticleInputs(text: string, name: string): CapturedArticleInput[] {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line, i) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`${name}:${i + 1}: not JSON`);
      }
      const record = parsed as { launchId?: unknown; input?: unknown; data?: { launchId?: unknown; input?: unknown } };
      const job = record.data ?? record;
      const launchId = Number(job.launchId);
      if (!Number.isInteger(launchId) || typeof job.input !== 'object' || job.input === null) throw new Error(`${name}:${i + 1}: no launchId and input`);
      return { launchId, input: job.input as CapturedArticleInput['input'] };
    });
}
