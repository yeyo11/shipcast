import { createFileRoute } from '@tanstack/react-router';
import { draining, readiness } from '@shipcast/runtime';
import { appContext } from '../server/context.server';

/**
 * Whether this process should be sent work: 503 while it drains (from the first moment of a stop)
 * or while the registry, or Redis when it is used, does not answer. Public and terse: each check's
 * state, never an address or a credential
 */
export const Route = createFileRoute('/readyz')({
  server: {
    handlers: {
      GET: async () => {
        const headers = { 'cache-control': 'no-store' };
        if (draining()) return Response.json({ ready: false, checks: { process: 'draining' } }, { status: 503, headers });
        let ctx: Awaited<ReturnType<typeof appContext>>;
        try {
          ctx = await appContext();
        } catch {
          return Response.json({ ready: false, checks: { process: 'starting failed' } }, { status: 503, headers });
        }
        const result = await readiness({ registry: ctx.registry, redis: ctx.process.usesRedis ? ctx.process.redis : undefined });
        // The checks' text is ours or the driver's error message: kept to the kind of failure
        const checks = Object.fromEntries(Object.entries(result.checks).map(([k, v]) => [k, v === 'ok' || v === 'draining' ? v : 'failing']));
        return Response.json({ ready: result.ready, role: ctx.role, checks }, { status: result.ready ? 200 : 503, headers });
      },
    },
  },
});
