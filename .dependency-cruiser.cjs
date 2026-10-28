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
      name: 'web-ui-not-connectors',
      comment: 'routes and components are entry points: they reach the networks through the server, never a connector directly',
      severity: 'error',
      from: { path: '^apps/web/src/(routes|components)/' },
      to: { path: ws('packages/connectors') },
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
    exclude: { path: '(^|/)(dist|build|\\.output|\\.tanstack|\\.vinxi)/' },
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
