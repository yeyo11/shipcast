import { Refused, type Channel } from '@shipcast/schema';
import { failureKey, failurePrefix, parseFailureKey } from '@shipcast/schema/failures';
import type { Launch, Registry } from '../registry.ts';
import type { PublishAttempts } from './attempts.ts';

// The failure keys live in the schema, where the app's pages read them too; the engine's entry points take them from here
export { failureKey, failurePrefix, parseFailureKey };

/**
 * The owner's Try again on one launch's channel: its failure is forgotten, its attempts that failed
 * or whose outcome is unknown are cleared, and a launch already published goes back to `drafted` if
 * that channel has nothing out yet, so the next publish tries it. Pieces already out stay out. The
 * channel stays failed for every other launch. Returns the launch as it is now.
 */
export async function retryChannel(registry: Registry, launchId: number, channel: Channel, attempts?: PublishAttempts): Promise<Launch | undefined> {
  await registry.deleteCursor(failureKey(launchId, channel));
  await attempts?.reset(launchId, channel);
  const launch = await registry.launches.get(launchId);
  if (!launch || launch.status !== 'published') return launch;
  // The newsletter has no single post: some issues may be out and others not, which the publish sorts out
  if ((await registry.posts(launchId, { channel, kind: 'post' })).length > 0) return launch;
  return registry.launches.setStatus(launchId, 'drafted', launch.detail);
}

/** Try again on a channel for every launch it failed on (`shipcast publish --retry`); the launches reopened */
export async function retryChannelEverywhere(registry: Registry, channel: Channel, attempts?: PublishAttempts): Promise<Launch[]> {
  const reopened: Launch[] = [];
  for (const { key } of await registry.cursorsWithPrefix(failurePrefix())) {
    const parsed = parseFailureKey(key);
    if (!parsed || parsed.channel !== channel) continue;
    const before = await registry.launches.get(parsed.launchId);
    const after = await retryChannel(registry, parsed.launchId, channel, attempts);
    if (before?.status !== 'drafted' && after?.status === 'drafted') reopened.push(after);
  }
  return reopened;
}

/** Why a launch cannot be published again */
export class PublishRefused extends Refused<'not_found' | 'state'> {}

/**
 * Publishing again, the owner's button on a launch and the API's retry: a channel that failed for
 * good gets another chance (retryChannel: only this launch's failure is forgotten), or, with no
 * channel, a drafted launch whose merge was missed is followed. Answers the launch as it is now, for
 * the caller to queue its publishing; refused when there is no such launch, or nothing to follow.
 */
export async function publishAgain(registry: Registry, launchId: number, channel: Channel | undefined, attempts?: PublishAttempts): Promise<Launch> {
  const launch = await registry.launches.get(launchId);
  if (!launch) throw new PublishRefused('not_found', 'no such launch');
  if (channel) return (await retryChannel(registry, launchId, channel, attempts)) ?? launch;
  if (launch.status !== 'drafted') throw new PublishRefused('state', `the launch is ${launch.status}`);
  return launch;
}
