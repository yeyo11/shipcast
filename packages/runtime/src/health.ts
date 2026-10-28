import { pingDatabase, type Repositories } from '@shipcast/engine';
import { draining } from './lifecycle.ts';
import type { RedisConnections } from './redis/connection.ts';

/*
 * The probes an orchestrator asks: /livez says the process is up (restart it if not), /readyz says
 * it should be sent work (take it out of the proxy if not). Ready is the registry answering, Redis
 * answering when this process uses it, and the process not draining.
 */

export interface Readiness {
  ready: boolean;
  checks: Record<string, string>;
}

const within = <T>(ms: number, work: Promise<T>): Promise<T> =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms).unref())]);

export async function readiness(deps: { registry: Pick<Repositories, 'database'>; redis?: RedisConnections | undefined; draining?: () => boolean }, timeoutMs = 2000): Promise<Readiness> {
  const checks: Record<string, string> = {};
  const isDraining = (deps.draining ?? draining)();
  checks.process = isDraining ? 'draining' : 'ok';
  const probe = async (name: string, work: () => Promise<unknown>) => {
    try {
      await within(timeoutMs, work());
      checks[name] = 'ok';
    } catch (error) {
      checks[name] = error instanceof Error ? error.message : String(error);
    }
  };
  const redis = deps.redis;
  await Promise.all([
    probe('postgres', () => pingDatabase(deps.registry.database)),
    ...(redis?.urls.queue ? [probe('redis-queue', () => redis.queue.ping())] : []),
    ...(redis?.urls.cache ? [probe('redis-cache', () => redis.cache.ping())] : []),
  ]);
  return { ready: Object.values(checks).every((v) => v === 'ok'), checks };
}
