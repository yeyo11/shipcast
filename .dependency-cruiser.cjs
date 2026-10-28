/*
 * The dependency rule of docs/plans/performance-refactor.md ("Target architecture"), checked on every
 * `pnpm typecheck` (so by the Sluice gate and by CI). Each rule passes today; the ones that encode
 * where the code is going rather than where it is are noted. Workspace packages are followed through
 * their node_modules links to their sources, so `@shipcast/engine` resolves to packages/engine/src.
 */

/** Node's modules that reach the disk, the network, processes or threads: what the domain never does */
const NODE_IO = [
  'fs', 'fs/promises', 'net', 'tls', 'http', 'https', 'http2', 'dgram', 'dns', 'dns/promises',
  'child_process', 'cluster', 'worker_threads', 'os', 'process', 'readline', 'inspector', 'vm',
];
const nodeIo = `^(node:)?(${NODE_IO.map((m) => m.replace('/', '\\/')).join('|')})$`;

/*
 * A workspace package, as a resolved path (packages/engine/…) or, when the importer does not declare
 * it and pnpm leaves it unresolvable, as its bare name (@shipcast/engine): either way it is caught.
 */
const ws = (...names) => names.flatMap((n) => [`^${n}/`, `^@shipcast/${n.split('/')[1]}(/|$)`]).join('|');
const anyWorkspace = '^(packages|apps)/|^@shipcast/';

/*
 * The AI layer before the AI task runner, kept while the `ai-runner` flag is verified in production:
 * the AiProvider port and its providers (engine's ai.ts), claudio's REST client (claudio.ts), their
 * one entry point (legacy-ai.ts, `@shipcast/engine/legacy-ai`) and the old streaming mock
 * (testing/ai.ts, `@shipcast/engine/testing/legacy-ai`). Every file below holds an old branch or an
 * old-path test; removing the layer is deleting those branches and these modules, so nothing new may
 * join the list.
 */
const LEGACY_AI = '^packages/engine/src/(ai|claudio|legacy-ai|testing/ai)[.]ts$|^@shipcast/engine/(testing/)?legacy-ai$';
const LEGACY_AI_FILES = [
  // The layer itself
  'packages/engine/src/ai.ts',
  'packages/engine/src/claudio.ts',
  'packages/engine/src/legacy-ai.ts',
  'packages/engine/src/testing/ai.ts',
  // The old branch of each task
  'packages/engine/src/pipeline.ts',
  'packages/engine/src/generate.ts',
  'packages/engine/src/article.ts',
  'packages/engine/src/comments.ts',
  'packages/engine/src/profile.ts',
  'packages/engine/src/assistant.ts',
  'packages/runtime/src/ai.ts',
  'packages/runtime/src/runtime.ts',
  'packages/runtime/src/comments.ts',
  'packages/runtime/src/profiles.ts',
  'apps/web/src/server/assistant.ts',
  'apps/web/src/server/assistant.server.ts',
  // Tests of the old path, or comparing it with the runner's
  'packages/engine/test/ai.test.ts',
  'packages/engine/test/article-review.test.ts',
  'packages/engine/test/article-runner.test.ts',
  'packages/engine/test/assistant.test.ts',
  'packages/engine/test/claudio.test.ts',
  'packages/engine/test/comments.characterisation.test.ts',
  'packages/engine/test/comments.test.ts',
  'packages/engine/test/generate.test.ts',
  'packages/engine/test/pack-runner.test.ts',
  'packages/engine/test/pipeline.test.ts',
  'packages/engine/test/profile.test.ts',
  'packages/engine/test/replies-runner.test.ts',
  'packages/runtime/test/profiles.test.ts',
  'apps/web/test/assistant.test.ts',
  'apps/web/test/assistant-runner.test.ts',
];
const exactly = (files) => `^(${files.map((f) => f.replace(/[.]/g, '[.]')).join('|')})$`;

module.exports = {
  forbidden: [
    {
      name: 'schema-is-pure',
      comment: 'packages/schema is the domain: no I/O modules of Node',
      severity: 'error',
      from: { path: '^packages/schema/src' },
      to: { dependencyTypes: ['core'], path: nodeIo },
    },
    {
      name: 'schema-imports-no-workspace-package',
      comment: 'packages/schema sits at the bottom: it imports no other workspace package',
      severity: 'error',
      from: { path: '^packages/schema/' },
      to: { path: anyWorkspace, pathNot: ws('packages/schema') },
    },
    {
      name: 'connectors-import-only-schema',
      comment: 'packages/connectors are adapters over the domain: of the workspace, only schema',
      severity: 'error',
      from: { path: '^packages/connectors/' },
      to: { path: anyWorkspace, pathNot: ws('packages/connectors', 'packages/schema') },
    },
    {
      name: 'engine-not-runtime-or-apps',
      comment: 'packages/engine never reaches up to the runtime or an app',
      severity: 'error',
      from: { path: '^packages/engine/' },
      to: { path: `${ws('packages/runtime', 'apps/web', 'apps/cli')}|^apps/` },
    },
    {
      name: 'runtime-not-apps',
      comment: 'packages/runtime is shared by the apps; it never imports one',
      severity: 'error',
      from: { path: '^packages/runtime/' },
      to: { path: `${ws('apps/web', 'apps/cli')}|^apps/` },
    },
    {
      name: 'packages-not-apps',
      comment: 'nothing under packages/ imports an app',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: `${ws('apps/web', 'apps/cli')}|^apps/` },
    },
    {
      name: 'web-entry-points-not-connectors-or-registry',
      comment:
        'routes, components and server functions (*.functions.ts) are entry points: they reach the networks and the registry ' +
        'through the engine services (apps/web/src/server/app-services.ts) and the *.server.ts modules, never a connector or ' +
        'the repositories. The engine re-exports them from its index, which a module rule cannot tell from the rest of ' +
        'the index: this catches a deep import, and the types themselves are kept out by review',
      severity: 'error',
      from: { path: '^apps/web/src/((routes|components)/|server/[^/]+[.]functions[.]tsx?$)' },
      to: { path: `${ws('packages/connectors')}|^packages/engine/src/repositories/` },
    },
    {
      name: 'no-registry-facade',
      comment:
        'the Registry god-class became one repository per aggregate (docs/plans/performance-refactor.md, phase 4) and its ' +
        'facade was removed once no consumer needed it: nothing imports packages/engine/src/registry.ts again. Remaining users: none',
      severity: 'error',
      from: {},
      to: { path: '^packages/engine/src/registry[.]ts$' },
    },
    {
      name: 'repositories-composed-in-one-place',
      comment:
        'the whole set of repositories is built (repositoriesOn, connectRepositories, memoryRepositories) only where the engine ' +
        'composes it: its index, the snapshot opener and the test kit. Every other engine module takes the Pick of Repositories ' +
        'it is handed, so it imports the bundle for its types only, and a repository\'s values from that repository itself',
      severity: 'error',
      from: { path: '^packages/engine/src/', pathNot: '^packages/engine/src/(index[.]ts$|repositories/|testing/|db/snapshot[.]ts$)' },
      to: { path: '^packages/engine/src/repositories/index[.]ts$', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'ai-provider-sdks-only-in-provider-modules',
      comment:
        'a provider SDK (@ai-sdk/anthropic, @ai-sdk/openai…) is imported only by its provider module in ' +
        'packages/engine/src/ai/providers and by the AI task runner: everything else asks the runner, so adding a provider is ' +
        'its module and a registry line. The SDK\'s shared types (@ai-sdk/provider, @ai-sdk/provider-utils) are not a provider. ' +
        'Remaining users until the old layer is removed: packages/engine/src/ai.ts and packages/engine/src/claudio.ts',
      severity: 'error',
      from: { pathNot: '^packages/engine/src/(ai/providers/|ai/runner[.]ts$|ai[.]ts$|claudio[.]ts$)' },
      to: { path: '(^|/)@ai-sdk/', pathNot: '(^|/)@ai-sdk/provider(-utils)?/' },
    },
    {
      name: 'legacy-ai-layer-only-in-legacy-files',
      comment:
        'the AI layer before the AI task runner (engine ai.ts, claudio.ts, legacy-ai.ts, testing/ai.ts) is imported only by ' +
        'the files of LEGACY_AI_FILES, each an old branch behind the ai-runner flag or a test of it: new code runs on the ' +
        'runner, and the layer is removed by deleting those branches and these modules',
      severity: 'error',
      from: { pathNot: exactly(LEGACY_AI_FILES) },
      to: { path: LEGACY_AI },
    },
    {
      name: 'no-cycles-between-packages',
      comment: 'workspace packages form a DAG: a cycle through two packages is a layering error',
      severity: 'error',
      from: { path: '^(packages|apps)/([^/]+)/' },
      to: {
        circular: true,
        // A cycle inside one package is that package's own business; one that leaves it is not
        viaSomeNot: '^$1/$2/',
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // The project's own build output; a package's `dist` under node_modules stays, as a leaf (it is not
    // followed), so a rule can see what is imported from it, such as a provider SDK
    exclude: { path: '^(packages|apps)/[^/]+/(dist|build|\\.output|\\.tanstack|\\.vinxi)/' },
    // TypeScript 7 has no compiler API dependency-cruiser can use yet: swc parses the sources
    parser: 'swc',
    tsPreCompilationDeps: true,
    combinedDependencies: false,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'node', 'default'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
      mainFields: ['module', 'main', 'types'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
