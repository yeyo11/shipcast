import { connectRepositories } from '../packages/engine/src/repositories/index.ts';
import { poolOptions } from '../packages/runtime/src/roles.ts';
import { compareReport, readWindow } from '../packages/engine/src/telemetry/report.ts';
import { TelemetryStore } from '../packages/engine/src/telemetry/store.ts';

/**
 * The measurement's numbers from the registry (docs/plans/performance-refactor.md, phase 0 and 10):
 *
 *   node scripts/measure.ts <from>..<to>                       one window, as JSON
 *   node scripts/measure.ts <from>..<to> <from>..<to>          the before/after report, in Markdown
 *
 * Moments are ISO 8601 (2026-10-28T12:00Z); the database is SHIPCAST_DATABASE_URL. Run where the
 * registry is: on the server, `docker compose exec web node scripts/measure.ts …`.
 */

function range(arg: string | undefined): { from: string; to: string } {
  const [from, to] = (arg ?? '').split('..');
  const iso = (s: string | undefined) => {
    const t = Date.parse(s ?? '');
    if (!Number.isFinite(t)) throw new Error(`not a window: "${arg}" (expected <from>..<to>, ISO 8601)`);
    return new Date(t).toISOString();
  };
  return { from: iso(from), to: iso(to) };
}

const url = process.env.SHIPCAST_DATABASE_URL;
if (!url) throw new Error('SHIPCAST_DATABASE_URL is not set');
const [first, second] = process.argv.slice(2);
// Through PgBouncer the migrator's session lock would stay on a pooled connection and block every later start:
// the migrator takes SHIPCAST_DATABASE_MIGRATE_URL, the direct address, when it is set
const registry = await connectRepositories(url, poolOptions(process.env));
try {
  const store = new TelemetryStore(registry.database);
  const before = await readWindow(store, range(first));
  if (second === undefined) console.log(JSON.stringify(before, null, 2));
  else console.log(compareReport(before, await readWindow(store, range(second))));
} finally {
  await registry.close();
}
