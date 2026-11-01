import { CHANNELS, type Channel, type ContentPack } from '@shipcast/schema';

/*
 * The texts seed-preview.ts gives its launches: the brand.yml and each repo's launch.yml the preview's
 * fixtures serve in place of GitHub, and the content packs of pando v1.0.0 (waiting for approval) and
 * claudio v1.5.0 (published), written as the AI would hand them over. Made up for the preview, in the
 * brand's own tone, so the review, content and preview screens have real text to show.
 */

export const SITE = 'https://josegarrido.dev';

/** The launches repo's brand.yml, its public fields as the real one has them */
export const BRAND_YML = `# The brand this launches repo publishes for (a preview's copy)
id: personal
displayName: José Antonio Garrido
site: ${SITE}
github: yeyo11

handles:
  bluesky: https://bsky.app/profile/josegarrido.dev
  mastodon: https://mastodon.social/@yeyo11
  devto: https://dev.to/yeyo11

support: https://buymeacoffee.com/yeyo11

languages:
  blog: [en, es]
  linkedin: es

tone: >
  Write as a developer telling other developers what they built, in the first person and talking
  to the reader directly. Lead with the concrete problem in one sentence, then teach. Practical,
  direct, no filler: no hype, no superlatives. Spanish is from Spain.
`;

/** A repo's .github/launch.yml: the channels given publish with approval, every other channel is off */
export function launchYml(channels: readonly Channel[], pack: 'launch' | 'major' | 'minor'): string {
  return [
    'enabled: true',
    'brand: personal',
    'language: en',
    `pack: ${pack}`,
    '',
    'publishing:',
    ...CHANNELS.map((c) => `  ${c}: ${channels.includes(c) ? 'approval' : 'off'}`),
    '',
  ].join('\n');
}

const pandoEn = `Your notes and your code drift apart the moment they live in different places. pando keeps them in one repo and makes both searchable from your editor's agent.

## What you get

- **One index for docs and code.** pando reads \`docs/\` as a knowledge base and the source by symbol, so one search answers "why did we do this" and "where does it happen".
- **An MCP server.** Claude Code, Cursor or any MCP client asks pando directly: \`kb_search_documents\` for the docs, \`code_hybrid_search\` for the code.
- **Wiki links that stay true.** Every document lists its related ones, and pando tells you when a link points nowhere.

## Try it

\`\`\`bash
npx pando init
npx pando serve
\`\`\`

\`init\` writes \`.pando.toml\` and indexes the repo; \`serve\` starts the MCP server on stdio. Add it to your client's MCP settings and ask it anything about the project.

## How it works

pando splits every Markdown file into sections and every source file into symbols, embeds both locally and keeps the index in \`.pando/\`. Reindexing only reads the files that changed since the last pass, so it takes seconds on a large repo.

## Why 1.0

The index format is stable now: an index built by 1.0 is read by every 1.x. That is the promise this version makes.
`;

const pandoEs = `Tus notas y tu código se separan en cuanto viven en sitios distintos. pando los guarda en el mismo repo y hace que ambos se puedan buscar desde el agente de tu editor.

## Qué obtienes

- **Un índice para la documentación y el código.** pando lee \`docs/\` como base de conocimiento y el código por símbolos, así que una búsqueda responde a "por qué lo hicimos" y a "dónde ocurre".
- **Un servidor MCP.** Claude Code, Cursor o cualquier cliente MCP le pregunta directamente a pando: \`kb_search_documents\` para la documentación, \`code_hybrid_search\` para el código.
- **Enlaces wiki que siguen siendo ciertos.** Cada documento lista los relacionados, y pando te avisa cuando un enlace no apunta a nada.

## Pruébalo

\`\`\`bash
npx pando init
npx pando serve
\`\`\`

\`init\` escribe \`.pando.toml\` e indexa el repo; \`serve\` arranca el servidor MCP por stdio. Añádelo a la configuración MCP de tu cliente y pregúntale lo que quieras sobre el proyecto.

## Cómo funciona

pando divide cada fichero Markdown en secciones y cada fichero de código en símbolos, los vectoriza en local y guarda el índice en \`.pando/\`. Reindexar solo lee los ficheros que cambiaron desde la última pasada, así que tarda segundos incluso en un repo grande.

## Por qué 1.0

El formato del índice ya es estable: un índice creado con la 1.0 lo lee cualquier 1.x. Esa es la promesa de esta versión.
`;

export function pandoPack(): ContentPack {
  return {
    schemaVersion: 1,
    kind: 'launch',
    project: { name: 'pando', repo: 'https://github.com/yeyo11/pando', version: 'v1.0.0' },
    analysis: {
      summary: 'pando indexes a repo’s docs/ folder as a knowledge base and its source by symbol, and serves both to coding agents over MCP.',
      implemented: ['Markdown knowledge base with wiki links and front matter', 'Source indexed by symbol with hybrid (keyword and vector) search', 'MCP server over stdio', 'Incremental reindexing of changed files', 'A stable index format across 1.x'],
      planned: ['An HTTP transport for the MCP server'],
      documentedOnly: [],
      limitations: ['Embeddings run locally: the first index of a large repo takes a few minutes'],
    },
    article: {
      tags: ['mcp', 'documentation', 'ai', 'devtools'],
      en: {
        slug: 'pando-docs-and-code-one-search',
        title: 'pando 1.0: your docs and your code, one search away',
        description: 'pando indexes your repo’s notes and source together and serves them to your coding agent over MCP. Version 1.0 makes the index format stable.',
        markdown: pandoEn,
        imageAlt: 'pando 1.0: docs and code in one index',
      },
      es: {
        slug: 'pando-documentacion-y-codigo-en-una-busqueda',
        title: 'pando 1.0: tu documentación y tu código, a una búsqueda',
        description: 'pando indexa juntas las notas y el código de tu repo y se los sirve a tu agente por MCP. La versión 1.0 estabiliza el formato del índice.',
        markdown: pandoEs,
        imageAlt: 'pando 1.0: documentación y código en un índice',
      },
    },
    bluesky: {
      lang: 'en',
      text: 'pando 1.0 is out 🌳 It indexes your repo’s docs/ and its code together and serves both to your coding agent over MCP. One search for "why" and "where". https://josegarrido.dev/en/pando-docs-and-code-one-search/?ref=bluesky',
    },
    mastodon: {
      lang: 'en',
      text: 'pando 1.0 is out. It keeps your notes in the repo and makes them searchable next to the code: docs/ as a knowledge base, the source by symbol, both served to Claude Code or any MCP client. The index format is stable from now on.\n\n#MCP #DevTools #Documentation https://josegarrido.dev/en/pando-docs-and-code-one-search/?ref=mastodon',
    },
    linkedin: {
      text: 'Las notas de un proyecto envejecen en cuanto viven lejos del código.\n\nHe publicado pando 1.0: indexa la carpeta docs/ de un repo como base de conocimiento y el código por símbolos, y se lo sirve a tu agente (Claude Code, Cursor o cualquier cliente MCP). Una sola búsqueda responde a "por qué lo hicimos" y a "dónde ocurre".\n\nLa 1.0 estabiliza el formato del índice: lo que indexes hoy lo leerá cualquier 1.x.\n\n#MCP #DevTools #Documentación',
    },
  };
}

const claudioEn = `Running several projects on one Claude account means one runaway agent can spend the month's budget in an afternoon. claudio 1.5 gives every API key its own budget.

## Per-key budgets

\`\`\`yaml
keys:
  - name: side-projects
    budgetUsd: 20
    period: month
\`\`\`

A key that reaches its budget gets a 429 with the reset date; the others keep working. The web UI shows each key's spend for the period.

## Streaming tools

Tool calls now stream as they are produced, with Claude and with any OpenAI-compatible model, so a long tool call shows its progress instead of a spinner.

## Local models

Any OpenAI-compatible server works as a provider, local ones included. The README has an Ollama example.
`;

const claudioEs = `Usar varios proyectos con una sola cuenta de Claude significa que un agente desbocado puede gastarse el presupuesto del mes en una tarde. claudio 1.5 da a cada clave de API su propio presupuesto.

## Presupuestos por clave

\`\`\`yaml
keys:
  - name: side-projects
    budgetUsd: 20
    period: month
\`\`\`

Una clave que llega a su presupuesto recibe un 429 con la fecha de reinicio; las demás siguen funcionando. La interfaz web muestra el gasto de cada clave en el periodo.

## Herramientas en streaming

Las llamadas a herramientas ahora llegan en streaming a medida que se generan, con Claude y con cualquier modelo compatible con OpenAI, así que una llamada larga muestra su progreso en lugar de un spinner.

## Modelos locales

Cualquier servidor compatible con OpenAI sirve como proveedor, también los locales. El README tiene un ejemplo con Ollama.
`;

export function claudioPack(): ContentPack {
  return {
    schemaVersion: 1,
    kind: 'minor',
    project: { name: 'Claudio', repo: 'https://github.com/yeyo11/claudio', version: 'v1.5.0' },
    analysis: {
      summary: 'claudio 1.5 adds a spend budget per API key, streams tool calls as they are produced, and accepts any OpenAI-compatible server as a provider.',
      implemented: ['Per-key budgets with a period and a 429 at the limit', 'Streaming tool calls for Claude and OpenAI-compatible models', 'OpenAI-compatible providers, local ones included'],
      planned: [],
      documentedOnly: [],
      limitations: [],
    },
    article: {
      tags: ['claude', 'ai', 'selfhosted', 'api'],
      en: { slug: 'claudio-v1-5-per-key-budgets', title: 'claudio 1.5: a budget for every API key', description: 'Per-key budgets, streaming tool calls and local models in claudio 1.5.', markdown: claudioEn },
      es: { slug: 'claudio-v1-5-presupuestos-por-clave', title: 'claudio 1.5: un presupuesto para cada clave de API', description: 'Presupuestos por clave, herramientas en streaming y modelos locales en claudio 1.5.', markdown: claudioEs },
    },
    devto: { tags: ['claude', 'ai', 'selfhosted', 'api'] },
    bluesky: {
      lang: 'en',
      text: 'claudio 1.5: every API key gets its own budget 💸 A runaway agent stops at its limit, the others keep going. Plus streaming tool calls and local models. https://josegarrido.dev/en/claudio-v1-5-per-key-budgets/?ref=bluesky',
    },
    mastodon: {
      lang: 'en',
      text: 'claudio 1.5 is out: a spend budget per API key (a key at its limit gets a 429, the rest keep working), tool calls that stream as they are produced, and any OpenAI-compatible server as a provider, local ones included.\n\n#Claude #SelfHosted #AI https://josegarrido.dev/en/claudio-v1-5-per-key-budgets/?ref=mastodon',
    },
    linkedin: {
      text: 'Un agente desbocado puede gastarse el presupuesto del mes en una tarde.\n\nclaudio 1.5 da a cada clave de API su propio presupuesto: al llegar al límite recibe un 429 y las demás siguen funcionando. También trae llamadas a herramientas en streaming y modelos locales compatibles con OpenAI.\n\n#IA #Claude #SelfHosted',
    },
    telegram: {
      text: 'claudio 1.5 is out: per-key budgets, streaming tool calls and local models. https://josegarrido.dev/en/claudio-v1-5-per-key-budgets/?ref=telegram',
    },
  };
}
