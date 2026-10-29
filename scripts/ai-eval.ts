import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { formatIssues, parseBrand } from '../packages/schema/src/index.ts';
import { compareEvals, evalSettings, loadEvalCases, readEvalDir, runEval, withAccess } from '../packages/engine/src/ai/eval.ts';
import { aiProviderDefinition } from '../packages/engine/src/ai/providers/registry.ts';
import { AiTaskRunner } from '../packages/engine/src/ai/runner.ts';
import { GitHubRest } from '../packages/engine/src/github.ts';
import { checkout } from '../packages/engine/src/workspace.ts';

/**
 * The A/B evaluation of the AI layer (packages/engine/src/ai/eval.ts):
 *
 *   node scripts/ai-eval.ts --yes-call-the-provider [--cases <file>] [--only a,b] [--access local-tools|remote-workspace]
 *   node scripts/ai-eval.ts --compare <dirA> <dirB>
 *
 * A run calls a real provider and spends its tokens, so it refuses without --yes-call-the-provider.
 * The provider comes from the environment, never from the owner's settings or keychain:
 * SHIPCAST_EVAL_PROVIDER (anthropic, claudio, openaiCompatible, openai), SHIPCAST_EVAL_PROVIDER_URL,
 * SHIPCAST_EVAL_PROVIDER_TOKEN, SHIPCAST_EVAL_MODEL. The repos are cloned shallow at each case's ref
 * into SHIPCAST_EVAL_WORKSPACE (a temp folder by default); a remote-workspace provider downloads each
 * repo itself, from the archive URL GitHub gives for GITHUB_TOKEN. Records go to data/evals/<timestamp>/.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'yes-call-the-provider': { type: 'boolean', default: false },
    cases: { type: 'string', default: join(root, 'scripts', 'ai-eval.cases.json') },
    only: { type: 'string' },
    access: { type: 'string' },
    compare: { type: 'boolean', default: false },
  },
});

if (values.compare) {
  const [a, b] = positionals;
  if (!a || !b) throw new Error('--compare takes two run folders: --compare <dirA> <dirB>');
  console.log(compareEvals(await readEvalDir(a), await readEvalDir(b), { a: 'A', b: 'B' }));
  process.exit(0);
}

if (!values['yes-call-the-provider']) {
  console.error('This calls a real AI provider and spends its tokens. Run it again with --yes-call-the-provider to go ahead.');
  process.exit(2);
}

const access = values.access;
if (access !== undefined && access !== 'local-tools' && access !== 'remote-workspace') throw new Error('--access is local-tools or remote-workspace');

const providerId = process.env.SHIPCAST_EVAL_PROVIDER;
const definition = providerId ? aiProviderDefinition(providerId) : undefined;
if (!definition) throw new Error(`SHIPCAST_EVAL_PROVIDER is not a provider: ${providerId ?? '(unset)'}`);
const provider = withAccess(definition, access);
const settings = evalSettings(provider, process.env);
const model = process.env.SHIPCAST_EVAL_MODEL ?? '';

const file = loadEvalCases(await readFile(values.cases, 'utf8'));
const only = values.only?.split(',').map((s) => s.trim());
const cases = only ? file.cases.filter((c) => only.includes(c.id)) : file.cases;
if (cases.length === 0) throw new Error(`no case matches --only ${values.only}`);

const hostDir = process.env.SHIPCAST_EVAL_WORKSPACE ?? (await mkdtemp(join(tmpdir(), 'shipcast-eval-')));
const workspace = { hostDir };

const brandCheckout = await checkout(workspace, file.brand.repo, file.brand.ref);
const brandText = await readFile(join(brandCheckout.hostPath, file.brand.path), 'utf8');
const brand = parseBrand(brandText);
if (!brand.ok) throw new Error(formatIssues(file.brand.path, brand.issues));

const outDir = join(root, 'data', 'evals', new Date().toISOString().replace(/[:.]/g, '-'));
const setup = { provider, settings, model };
const githubToken = process.env.GITHUB_TOKEN;
if (provider.capabilities.repoAccess === 'remote-workspace' && !githubToken) throw new Error('a remote-workspace provider downloads the repo from GitHub: set GITHUB_TOKEN');
const runner = new AiTaskRunner({ resolve: async () => setup, ...(githubToken && { archives: new GitHubRest({ token: githubToken }) }) });
console.log(`${cases.length} cases on ${provider.name}${model ? ` (${model})` : ''}, ${provider.capabilities.repoAccess}; records in ${outDir}`);
await runEval(cases, {
  runner,
  setup,
  brand: brand.value,
  outDir,
  checkout: async (repo, ref) => (await checkout(workspace, repo, ref)).hostPath,
  log: (line) => console.log(line),
});
console.log(`done: ${outDir}`);
