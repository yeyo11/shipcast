/*
 * A channel that failed for good is a cursor whose value is the network's words, and which keeps the
 * channel from being tried again until the owner asks. Its key is built and read here only; this
 * module imports nothing, so the app's pages can read failure keys without the schema's validators.
 */
const PREFIX = 'publish-failed:';

export const failureKey = (launchId: number, channel: string): string => `${PREFIX}${launchId}:${channel}`;

/** The prefix of every failure, or of one launch's */
export const failurePrefix = (launchId?: number): string => (launchId === undefined ? PREFIX : `${PREFIX}${launchId}:`);

/** `publish-failed:12:devto` into its launch and channel; anything else is not a failure */
export function parseFailureKey(key: string): { launchId: number; channel: string } | null {
  const match = /^publish-failed:(\d+):(.+)$/.exec(key);
  return match ? { launchId: Number(match[1]), channel: match[2] ?? '' } : null;
}
