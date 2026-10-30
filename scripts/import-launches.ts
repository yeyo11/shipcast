/**
 * Imports the launches drafted before Shipcast held them into the launch model, and deletes the ones
 * decided away (docs/launch-import.md, docs/decisions/launch-model.md):
 *
 *   node scripts/import-launches.ts [--delete 2,4,7] [--at <sha>] [--inputs <file.jsonl>]...   the plan, written nowhere
 *   node scripts/import-launches.ts --apply [same options]                                    writes it, then verifies
 *   node scripts/import-launches.ts --verify <batch> [--database-is-copy]
 *   node scripts/import-launches.ts --rollback <batch>
 *
 * Reads Postgres at SHIPCAST_DATABASE_URL and the launches repo through GitHub's API with
 * GITHUB_TOKEN (GETs only; any token that may read the repos). Writing needs `launch-import` in
 * SHIPCAST_FLAGS, and the media store (`launch-media` with SHIPCAST_MEDIA_*) for the files. Take a
 * pg_dump first. `--verify` runs with `launch-import` on, or with `--database-is-copy` on a restored
 * copy: connecting migrates the database, so it never runs on production by accident. The target
 * (host and database, never the password) is printed before anything connects. `--inputs` adds the
 * owner's article inputs captured outside the database (BullMQ's jobs, one per line); pg-boss's are
 * read from the database itself.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { connectRepositories, databaseTarget, describePlan, GitHubRest, inTransaction, LaunchImportService, parseArticleInputs, type CapturedArticleInput, type Verification, verifyRefusal } from '../packages/engine/src/index.ts';
import { dryPublishing, Flags, mediaStoreFor } from '../packages/runtime/src/index.ts';

const root = resolve(import.meta.dirname, '..');
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));

/** The launches docs/decisions/launch-model.md deletes: the skipped test articles and the failed v0.2.0 */
const DECIDED_DELETIONS = [2, 4, 7];

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const options = (name: string): string[] => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []));

const url = process.env.SHIPCAST_DATABASE_URL?.trim();
const token = process.env.GITHUB_TOKEN?.trim();
if (!url || !token) {
  console.error(`${url ? 'GITHUB_TOKEN' : 'SHIPCAST_DATABASE_URL'} is not set`);
  process.exit(2);
}

const flags = Flags.fromEnv(process.env);
// Named before connecting, since connecting already migrates it: the owner sees which database this is first
console.log(`Database ${databaseTarget(url)}`);
const verifyBatch = option('--verify');
const refused = verifyBatch ? verifyRefusal({ writable: flags.on('launch-import'), databaseIsCopy: args.includes('--database-is-copy') }) : undefined;
if (refused) {
  console.error(refused);
  process.exit(2);
}
const registry = await connectRepositories(url);
try {
  const launchesRepo = process.env.SHIPCAST_LAUNCHES_REPO?.trim() || (await registry.settings.setting<string>('launches-repo'));
  if (!launchesRepo) throw new Error('no launches repo: set SHIPCAST_LAUNCHES_REPO or the launches-repo setting');
  const inputs: CapturedArticleInput[] = options('--inputs').flatMap((path) => parseArticleInputs(readFileSync(path, 'utf8'), basename(path)));
  const service = new LaunchImportService({
    registry,
    inTransaction: (work) => inTransaction(registry, work),
    github: new GitHubRest({ token }),
    media: mediaStoreFor(flags, process.env),
    launchesRepo,
    inputs,
    dryPublishing: () => dryPublishing(),
    writable: flags.on('launch-import'),
  });
  console.log(`Launches repo ${launchesRepo}`);

  const rollbackBatch = option('--rollback');
  if (rollbackBatch) {
    const removed = await service.rollback(rollbackBatch);
    console.log(`Rolled back ${rollbackBatch}: ${Object.entries(removed).map(([table, n]) => `${table} ${n}`).join(', ')}`);
    console.log('The files stay in the media store, addressed by their content.');
  } else if (verifyBatch) {
    process.exitCode = report(await service.verify(verifyBatch));
  } else {
    const deletions = (option('--delete') ?? DECIDED_DELETIONS.join(',')).split(',').filter(Boolean).map(Number);
    const at = option('--at');
    const plan = await service.plan({ deletions, ...(at && { at }) });
    for (const line of describePlan(plan)) console.log(line);
    if (!args.includes('--apply')) {
      console.log('\nDry run: nothing was written. Run again with --apply (and launch-import in SHIPCAST_FLAGS) to write it.');
    } else {
      const batch = await service.apply(plan);
      if (!batch) {
        console.log('\nNothing to import or delete: every launch is done already.');
      } else {
        console.log(`\nApplied as batch ${batch}. Verifying…`);
        process.exitCode = report(await service.verify(batch));
        console.log(`Roll it back with: node scripts/import-launches.ts --rollback ${batch}`);
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await registry.close();
}

function report(verification: Verification): number {
  console.log(`\nVerification of batch ${verification.batch}`);
  for (const line of verification.passed) console.log(`  ok   ${line}`);
  for (const line of verification.problems) console.log(`  FAIL ${line}`);
  console.log(verification.problems.length === 0 ? 'Every check passed.' : `${verification.problems.length} check(s) failed.`);
  return verification.problems.length === 0 ? 0 : 1;
}
